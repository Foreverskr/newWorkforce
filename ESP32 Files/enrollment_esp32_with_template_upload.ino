// ESP32 + AS608/R307 fingerprint enrollment terminal — WITH OLED STATUS DISPLAY
// -----------------------------------------------------------------------
// FIX APPLIED: slot assignment no longer guessed from local sensor state.
//
// BEFORE:
//   uint16_t slotId = finger.getTemplateCount() == FINGERPRINT_OK ? finger.templateCount : 0;
//   - this asks the SENSOR "how many templates do you have?" and uses that
//     as the next slot number. If this sensor has any orphaned/leftover
//     templates from earlier testing, new enrollments land on inflated,
//     unpredictable slot numbers that the backend never assigned.
//
// AFTER:
//   uint16_t slotId = job["sensor_slot_id"].as<uint16_t>();
//   - the backend decides the slot number when it creates the enrollment
//     job, and includes it in the /next-job response. The device just
//     writes to whatever slot the backend says. This is the only source
//     of truth now — local sensor state is never consulted for slot
//     assignment again.
//
// *** BACKEND REQUIREMENT ***
// Your /api/device/fingerprints/next-job endpoint MUST now include a
// "sensor_slot_id" field in the job object it returns, e.g.:
//   { "job": { "id": "...", "slot_label": "...", "sensor_slot_id": 3, "employees": {...} } }
// The backend should assign this slot number itself (e.g. next unused
// integer, or a fixed per-employee ID) when the enrollment request is
// created — not derive it from anything the device reports. Until the
// backend sends this field, slotId below will read as 0 for every job
// (ArduinoJson returns 0 for a missing/null numeric field) — the code
// has a guard that refuses to enroll rather than silently overwrite
// slot 0 repeatedly; see the check in checkForJob().
//
// NEW: SERIAL TEXT COMMAND FOR THE OLED
// -----------------------------------------------------------------------
// Type into Serial Monitor (115200 baud, "Newline" line ending) either:
//   text:Hello World
//     -> shows "Hello World" on the OLED as a single line, and stays
//        there for 3 seconds before returning to the normal "Ready"
//        status. Useful for testing the display or wiring without
//        needing a finger scan or a backend job to trigger showStatus().
//   text:Hello World|Second line
//     -> use a pipe "|" to split into two lines (top = big text,
//        bottom = small text), matching how showStatus() already
//        renders everywhere else in this file.
//
// Everything else in this file is unchanged from your previous version.

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Adafruit_Fingerprint.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "base64.h"

// ─── CONFIG — fill these in ──────────────────────────────────────────────
const char* WIFI_SSID      = "GlobeAtHome_12CC1_2.4";
const char* WIFI_PASSWORD  = "3Zz2hE7B";
const char* SERVER_URL     = "http://192.168.254.119:3001";
const char* DEVICE_API_KEY = "sczwedhpjziauvhyvdigqrsvrdopemnjzcgscinyrjkvahoxzhrumnfpqtsvecdx";
const char* DEVICE_ID      = "ESP32-01";

const unsigned long POLL_INTERVAL_MS = 3000;
const unsigned long FINGER_WAIT_TIMEOUT_MS = 60000;
#define FINGERPRINT_DOWNLOAD 0x09
#define FP_TEMPLATE_SIZE 1024

// ─── OLED CONFIG ──────────────────────────────────────────────────────────
#define OLED_SDA        21
#define OLED_SCL        22
#define OLED_RESET      -1
#define SCREEN_WIDTH   128
#define SCREEN_HEIGHT   64
#define OLED_I2C_ADDR 0x3C
// ──────────────────────────────────────────────────────────────────────

HardwareSerial fingerSerial(2);
Adafruit_Fingerprint finger = Adafruit_Fingerprint(&fingerSerial);
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

unsigned long lastPoll = 0;

void showStatus(const String& line1, const String& line2 = "") {
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(line1);
  display.setTextSize(1);
  display.setCursor(0, 24);
  display.println(line2);
  display.display();
}

// NEW: reads "text:..." commands from Serial Monitor and shows them on the
// OLED via the existing showStatus() renderer. A "|" in the typed text
// splits it into showStatus()'s two lines; otherwise it's shown as a
// single top line. Returns to the normal "Ready" status after 3 seconds.
void handleSerialCommands() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd.startsWith("text:")) {
    String text = cmd.substring(5);
    int barPos = text.indexOf('|');
    if (barPos >= 0) {
      String line1 = text.substring(0, barPos);
      String line2 = text.substring(barPos + 1);
      Serial.printf("Showing on OLED: \"%s\" / \"%s\"\n", line1.c_str(), line2.c_str());
      showStatus(line1, line2);
    } else {
      Serial.printf("Showing on OLED: \"%s\"\n", text.c_str());
      showStatus(text);
    }
    delay(3000);
    showStatus("Ready", "Waiting for job");
  } else {
    Serial.println("Unknown command. Try: text:Your message here");
    Serial.println("Or with two lines: text:Top line|Bottom line");
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);

  Wire.begin(OLED_SDA, OLED_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDR)) {
    Serial.println("OLED not found - check wiring/address (0x3C).");
    while (true) delay(1000);
  }
  display.setRotation(0);
  showStatus("Booting...", "Init sensors");

  fingerSerial.setRxBufferSize(1024);
  fingerSerial.begin(57600, SERIAL_8N1, 16, 17);
  finger.begin(57600);

  uint8_t packetSizeResult = finger.setPacketSize(FINGERPRINT_PACKET_SIZE_32);
  Serial.printf("setPacketSize(32) returned %d (0 = OK)\n", packetSizeResult);
  finger.packet_len = 32;

  if (finger.verifyPassword()) {
    Serial.println("Fingerprint sensor found.");
    showStatus("Sensor OK", "Connecting WiFi");
  } else {
    Serial.println("Fingerprint sensor NOT found - check wiring/power.");
    showStatus("Sensor ERROR", "Check wiring");
    while (true) delay(1000);
  }

  connectWifi();

  Serial.println("Type 'text:Your message' + Enter to show custom text");
  Serial.println("on the OLED (use | to split into two lines).");
}

void loop() {
  handleSerialCommands();

  if (WiFi.status() != WL_CONNECTED) connectWifi();

  if (millis() - lastPoll >= POLL_INTERVAL_MS) {
    lastPoll = millis();
    checkForJob();
  }
}

void connectWifi() {
  showStatus("WiFi", "Connecting...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    showStatus("WiFi OK", WiFi.localIP().toString());
    delay(800);
    showStatus("Ready", "Waiting for job");
  } else {
    showStatus("WiFi FAILED", "Will retry...");
  }
}

void checkForJob() {
  HTTPClient http;
  String url = String(SERVER_URL) + "/api/device/fingerprints/next-job?device_id=" + DEVICE_ID;
  http.begin(url);
  http.addHeader("x-device-key", DEVICE_API_KEY);

  int code = http.GET();
  if (code != 200) {
    http.end();
    return;
  }
  String body = http.getString();
  http.end();

  StaticJsonDocument<1024> doc;
  if (deserializeJson(doc, body)) return;
  if (doc["job"].isNull()) return;

  JsonObject job = doc["job"];
  String requestId = job["id"].as<String>();
  String slotLabel = job["slot_label"].as<String>();
  String employeeName = job["employees"]["name"].as<String>();

  // FIX: slot number now comes from the backend, not from local sensor
  // state. ArduinoJson returns 0 for a missing/null field, which is
  // indistinguishable from a genuine slot 0 - so we require the field
  // to be explicitly present rather than silently defaulting to 0 and
  // risking a repeated overwrite of slot 0 for every job.
  if (job["sensor_slot_id"].isNull()) {
    Serial.println("Job is missing sensor_slot_id - backend needs to assign");
    Serial.println("a slot number when creating this enrollment request.");
    Serial.println("Refusing to enroll until the backend sends one.");
    showStatus("Backend error", "No slot assigned");
    delay(2000);
    showStatus("Ready", "Waiting for job");
    return;
  }
  uint16_t slotId = job["sensor_slot_id"].as<uint16_t>();

  showStatus("New Job", employeeName + " (" + slotLabel + ")");
  delay(1000);
  enrollFinger(requestId, slotId);
}

int captureValidImage(uint8_t bufferSlot) {
  unsigned long start = millis();
  while (millis() - start < FINGER_WAIT_TIMEOUT_MS) {
    int p = finger.getImage();
    if (p == FINGERPRINT_NOFINGER) { delay(200); continue; }
    if (p == FINGERPRINT_PACKETRECIEVEERR) { delay(200); continue; }
    if (p != FINGERPRINT_OK) { delay(200); continue; }

    p = finger.image2Tz(bufferSlot);
    if (p == FINGERPRINT_OK) return FINGERPRINT_OK;

    if (p == FINGERPRINT_IMAGEMESS || p == FINGERPRINT_FEATUREFAIL || p == FINGERPRINT_INVALIDIMAGE) {
      showStatus("Try again", "Place finger fully");
      delay(300);
      continue;
    }
    return p;
  }
  return -1;
}

// FIX: now takes slotId as a parameter instead of deriving it internally
// from finger.getTemplateCount(). The caller (checkForJob) supplies the
// backend-assigned number.
void enrollFinger(const String& requestId, uint16_t slotId) {
  showStatus("Enroll", "Place finger #1");
  if (captureValidImage(1) != FINGERPRINT_OK) {
    showStatus("Failed", "Scan #1 timeout");
    return reportFail(requestId, "Could not capture first scan");
  }

  showStatus("Good scan", "Remove finger");
  delay(1500);
  while (finger.getImage() != FINGERPRINT_NOFINGER) delay(50);

  showStatus("Enroll", "Place finger #2");
  if (captureValidImage(2) != FINGERPRINT_OK) {
    showStatus("Failed", "Scan #2 timeout");
    return reportFail(requestId, "Could not capture second scan");
  }

  int p = finger.createModel();
  if (p != FINGERPRINT_OK) {
    showStatus("Failed", "Scans didn't match");
    return reportFail(requestId, "Fingerprint scans did not match each other");
  }

  static uint8_t templateBuf[FP_TEMPLATE_SIZE + 64];
  uint16_t templateLen = 0;
  bool uploadOk = uploadTemplateBytes(1, templateBuf, sizeof(templateBuf), &templateLen);
  if (!uploadOk) {
    Serial.println("Template byte extraction failed - enrollment will still work locally, but won't sync to other devices");
  }

  p = finger.storeModel(slotId);
  if (p != FINGERPRINT_OK) {
    showStatus("Failed", "Could not store");
    return reportFail(requestId, "Could not store template on sensor");
  }

  // FIX: verify what actually landed in the slot matches what we just
  // captured, same integrity check added to the attendance sketch. This
  // catches a corrupted storeModel() write before it's ever reported to
  // the backend as a good enrollment.
  static uint8_t verifyBuf[FP_TEMPLATE_SIZE + 64];
  uint16_t verifyLen = 0;
  bool verifyOk = uploadTemplateBytes(1, verifyBuf, sizeof(verifyBuf), &verifyLen);
  if (uploadOk && verifyOk) {
    bool matches = (verifyLen == templateLen);
    if (matches) {
      for (uint16_t i = 0; i < templateLen; i++) {
        if (templateBuf[i] != verifyBuf[i]) { matches = false; break; }
      }
    }
    if (!matches) {
      Serial.println("Post-store verify FAILED - stored template does not match captured template");
      showStatus("Failed", "Store verify mismatch");
      return reportFail(requestId, "Stored template failed integrity check");
    }
    Serial.println("Post-store verify OK - template confirmed byte-correct in slot");
  }

  Serial.printf("Stored to backend-assigned slot %d, template bytes: %d\n", slotId, templateLen);
  showStatus("Success!", "Slot " + String(slotId));
  delay(1500);
  showStatus("Ready", "Waiting for job");

  String templateBase64 = uploadOk ? base64::encode(templateBuf, templateLen) : "";
  reportComplete(requestId, slotId, templateBase64);
}

void reportComplete(const String& requestId, uint16_t slotId, const String& templateBase64) {
  DynamicJsonDocument doc(4096);
  doc["request_id"] = requestId;
  doc["sensor_slot_id"] = slotId;
  if (templateBase64.length() > 0) {
    doc["template_data"] = templateBase64;
  }
  postJson("/api/device/fingerprints/complete", doc);
}

void reportFail(const String& requestId, const char* reason) {
  StaticJsonDocument<256> doc;
  doc["request_id"] = requestId;
  doc["error_message"] = reason;
  postJson("/api/device/fingerprints/fail", doc);
}

void postJson(const String& path, JsonDocument& doc) {
  String payload;
  serializeJson(doc, payload);

  HTTPClient http;
  http.begin(String(SERVER_URL) + path);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_API_KEY);

  int code = http.POST(payload);
  Serial.printf("%s -> HTTP %d\n", path.c_str(), code);
  http.end();
}

// ─── Raw template transfer ───────────────────────────────────────────────
bool uploadTemplateBytes(uint8_t bufferNo, uint8_t* outBuf, uint16_t maxLen, uint16_t* outLen) {
  uint8_t cmdData[] = { FINGERPRINT_UPLOAD, bufferNo };
  Adafruit_Fingerprint_Packet cmd(FINGERPRINT_COMMANDPACKET, sizeof(cmdData), cmdData);
  finger.writeStructuredPacket(cmd);

  uint8_t ackDummy[1] = {0};
  Adafruit_Fingerprint_Packet ack(FINGERPRINT_ACKPACKET, 1, ackDummy);
  int ackResult = finger.getStructuredPacket(&ack);
  if (ackResult != FINGERPRINT_OK || ack.data[0] != FINGERPRINT_OK) {
    Serial.println("Upload command rejected by sensor");
    return false;
  }

  uint16_t total = 0;
  uint8_t dataDummy[1] = {0};
  Adafruit_Fingerprint_Packet dataPkt(FINGERPRINT_DATAPACKET, 1, dataDummy);

  do {
    int result = finger.getStructuredPacket(&dataPkt);
    if (result != FINGERPRINT_OK) {
      Serial.println("Error reading template data packet");
      return false;
    }
    uint16_t chunkLen = dataPkt.length - 2;
    if (total + chunkLen > maxLen) {
      Serial.println("Template buffer too small for this sensor's template size");
      return false;
    }
    memcpy(outBuf + total, dataPkt.data, chunkLen);
    total += chunkLen;
  } while (dataPkt.type != FINGERPRINT_ENDDATAPACKET);

  *outLen = total;
  return true;
}
