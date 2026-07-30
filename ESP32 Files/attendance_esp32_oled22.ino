// ESP32 + AS608/R307 attendance kiosk — WITH 2.8" ILI9341 TFT STATUS DISPLAY
// Adapted for Adafruit_ILI9341 (tested & working display)
// -----------------------------------------------------------------------

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Adafruit_Fingerprint.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>
#include "time.h"
#include "base64.h"

// ─── CONFIG — fill these in ──────────────────────────────────────────────
const char* WIFI_SSID      = "GlobeAtHome_12CC1_2.4";
const char* WIFI_PASSWORD  = "3Zz2hE7B";
const char* SERVER_URL     = "http://192.168.254.119:3001";
const char* DEVICE_API_KEY = "gpzgbwlukzkhhdzzvnfevvfifnsfshizchucptdcdqjpcjmnbgyctsuycetehdwq";
const char* DEVICE_ID      = "ESP32-ATTEND-01";

const unsigned long SCAN_LOOP_DELAY_MS = 200;
const unsigned long SYNC_INTERVAL_MS   = 60000;

#define FP_TEMPLATE_SIZE 1024
#define FINGERPRINT_DOWNLOAD 0x09
#define MIN_CONFIDENCE_THRESHOLD 80

// ─── TFT CONFIG (ILI9341) ─────────────────────────────────────────────────
#define TFT_CS   5
#define TFT_DC   2
#define TFT_RST  4
// SCK/MOSI/MISO use ESP32's default VSPI pins (18 / 23 / 19)

// ─── NTP / CLOCK CONFIG ───────────────────────────────────────────────────
const char* NTP_SERVER   = "pool.ntp.org";
const long  TZ_OFFSET_SEC = 8 * 3600; // Asia/Manila, UTC+8, no DST
const int   DST_OFFSET_SEC = 0;

// ─── COLORS (ILI9341) ──────────────────────────────────────────────────────
#define COL_BG      ILI9341_BLACK
#define COL_TEXT    ILI9341_WHITE
#define COL_DIM     0x7BEF   // mid-grey
#define COL_ACCENT  ILI9341_CYAN
#define COL_OK      ILI9341_GREEN
#define COL_WARN    ILI9341_YELLOW
#define COL_ERR     ILI9341_RED

HardwareSerial fingerSerial(2);
Adafruit_Fingerprint finger = Adafruit_Fingerprint(&fingerSerial);
Adafruit_ILI9341 tft(TFT_CS, TFT_DC, TFT_RST);

unsigned long lastSync = 0;
unsigned long lastClockTick = 0;
bool idleScreenActive = false;

String lastPunchName = "";
String lastPunchTime = "";

// Step tracker: which stage of the scan pipeline we're in, for the top bar
enum ScanStep { STEP_NONE = -1, STEP_SCAN = 0, STEP_MATCH = 1, STEP_VERIFY = 2, STEP_SYNC = 3 };
const char* STEP_LABELS[4] = { "SCAN", "MATCH", "VERIFY", "SYNC" };

size_t base64Decode(const String &input, uint8_t *output, size_t maxLen) {
  static const char* b64chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  static int decTable[256];
  static bool tableInit = false;
  if (!tableInit) {
    for (int i = 0; i < 256; i++) decTable[i] = -1;
    for (int i = 0; i < 64; i++) decTable[(unsigned char)b64chars[i]] = i;
    tableInit = true;
  }

  size_t inLen = input.length();
  size_t outLen = 0;
  uint32_t buf = 0;
  int bits = 0;
  for (size_t i = 0; i < inLen; i++) {
    char c = input[i];
    if (c == '=' || c == '\n' || c == '\r' || c == ' ') continue;
    int val = decTable[(unsigned char)c];
    if (val < 0) continue;
    buf = (buf << 6) | (uint32_t)val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (outLen >= maxLen) {
        Serial.println("base64Decode: output buffer full, truncating");
        return outLen;
      }
      output[outLen++] = (uint8_t)((buf >> bits) & 0xFF);
    }
  }
  return outLen;
}

// ─── DISPLAY HELPERS ──────────────────────────────────────────────────────

String currentTimeString() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, 0)) return "--:--:--";
  char buf[16];
  strftime(buf, sizeof(buf), "%H:%M:%S", &timeinfo);
  return String(buf);
}

String currentDateString() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, 0)) return "";
  char buf[24];
  strftime(buf, sizeof(buf), "%b %d, %Y", &timeinfo);
  return String(buf);
}

// Top bar: WiFi status dot + live clock. Cheap to redraw, called often.
void drawHeader() {
  tft.fillRect(0, 0, 320, 22, COL_BG);
  tft.drawFastHLine(0, 22, 320, COL_DIM);

  tft.setTextSize(1);
  tft.setTextColor(WiFi.status() == WL_CONNECTED ? COL_OK : COL_ERR);
  tft.setCursor(6, 7);
  tft.print(WiFi.status() == WL_CONNECTED ? "WiFi OK" : "WiFi --");

  tft.setTextColor(COL_TEXT);
  String t = currentTimeString();
  tft.setCursor(320 - (t.length() * 6) - 6, 7);
  tft.print(t);
}

// Step tracker bar under the header: SCAN > MATCH > VERIFY > SYNC
void drawSteps(ScanStep active) {
  int y = 30;
  int colW = 320 / 4;
  for (int i = 0; i < 4; i++) {
    uint16_t col = (i == (int)active) ? COL_ACCENT : COL_DIM;
    tft.fillRoundRect(i * colW + 6, y, colW - 12, 22, 4, (i == (int)active) ? COL_ACCENT : COL_BG);
    tft.drawRoundRect(i * colW + 6, y, colW - 12, 22, 4, col);
    tft.setTextSize(1);
    tft.setTextColor((i == (int)active) ? ILI9341_BLACK : COL_DIM);
    int textX = i * colW + 6 + ((colW - 12) - strlen(STEP_LABELS[i]) * 6) / 2;
    tft.setCursor(textX, y + 7);
    tft.print(STEP_LABELS[i]);
  }
}

// Footer: last successful punch, small and dim so it doesn't compete
// with the main message.
void drawFooter() {
  tft.fillRect(0, 224, 320, 16, COL_BG);
  tft.drawFastHLine(0, 222, 320, COL_DIM);
  tft.setTextSize(1);
  tft.setTextColor(COL_DIM);
  tft.setCursor(6, 227);
  if (lastPunchName.length() == 0) {
    tft.print("No punches yet this session");
  } else {
    tft.print("Last: " + lastPunchName + "  " + lastPunchTime);
  }
}

// Main status area (between header/steps and footer). color tints the
// big message so OK/warning/error are visually distinct, not just text.
void showStatus(const String& line1, const String& line2 = "", uint16_t color = COL_TEXT, ScanStep step = STEP_NONE) {
  idleScreenActive = false;
  drawHeader();
  drawSteps(step);

  tft.fillRect(0, 58, 320, 160, COL_BG);
  tft.setTextColor(color);
  tft.setTextSize(3);
  tft.setCursor(10, 90);
  tft.print(line1);

  if (line2.length() > 0) {
    tft.setTextSize(2);
    tft.setTextColor(COL_DIM);
    tft.setCursor(10, 140);
    tft.print(line2);
  }

  drawFooter();
}

// The idle "Ready" screen is drawn once, then only the clock in the header
// ticks over every second - avoids full-screen redraw flicker while nobody
// is scanning.
void showIdleScreen() {
  showStatus("Ready", "Place finger to scan", COL_ACCENT, STEP_NONE);
  tft.setTextSize(1);
  tft.setTextColor(COL_DIM);
  tft.setCursor(10, 165);
  tft.print(currentDateString());
  idleScreenActive = true;
}

void setup() {
  Serial.begin(115200);
  delay(300);

  // Initialize SPI and TFT display
  SPI.begin(18, 19, 23, TFT_CS);
  tft.begin();
  tft.setRotation(1);          // landscape
  tft.fillScreen(ILI9341_BLACK);
  showStatus("Booting...", "Init sensor", COL_TEXT);

  fingerSerial.setRxBufferSize(1024);
  fingerSerial.begin(57600, SERIAL_8N1, 16, 17);
  finger.begin(57600);

  if (!finger.verifyPassword()) {
    Serial.println("Fingerprint sensor NOT found - check wiring/power.");
    showStatus("Sensor ERROR", "Check wiring", COL_ERR);
    while (true) delay(1000);
  }
  Serial.println("Fingerprint sensor found.");

  uint8_t packetSizeResult = finger.setPacketSize(FINGERPRINT_PACKET_SIZE_32);
  Serial.printf("setPacketSize(32) returned %d (0 = OK)\n", packetSizeResult);
  finger.packet_len = 32;

  Serial.println("Type 'wipe' + Enter in Serial Monitor to erase all");
  Serial.println("templates on this sensor AND reset the backend's sync");
  Serial.println("records for this device, then resync from scratch.");

  connectWifi();

  showStatus("Syncing time...", "", COL_TEXT);
  configTime(TZ_OFFSET_SEC, DST_OFFSET_SEC, NTP_SERVER);
  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 5000)) {
    Serial.println("Time synced: " + currentDateString() + " " + currentTimeString());
  } else {
    Serial.println("NTP sync failed - clock will show placeholder time.");
  }

  syncPendingTemplates();
  showIdleScreen();
}

void loop() {
  handleSerialCommands();

  if (WiFi.status() != WL_CONNECTED) connectWifi();

  if (millis() - lastSync >= SYNC_INTERVAL_MS) {
    lastSync = millis();
    syncPendingTemplates();
    showIdleScreen();
  }

  // Tick the header clock once a second while idle, without a full redraw
  if (idleScreenActive && millis() - lastClockTick >= 1000) {
    lastClockTick = millis();
    drawHeader();
  }

  int p = finger.getImage();
  if (p == FINGERPRINT_OK) {
    showStatus("Reading print...", "", COL_TEXT, STEP_SCAN);
    p = finger.image2Tz(1);
    if (p == FINGERPRINT_OK) {
      showStatus("Searching...", "", COL_TEXT, STEP_MATCH);
      p = finger.fingerFastSearch();
      if (p == FINGERPRINT_OK) {
        Serial.printf("Raw match: slot %d, confidence %d\n", finger.fingerID, finger.confidence);

        if (finger.confidence >= MIN_CONFIDENCE_THRESHOLD) {
          Serial.printf("ACCEPTED: Matched slot %d (confidence %d)\n", finger.fingerID, finger.confidence);
          showStatus("Verifying...", "", COL_TEXT, STEP_VERIFY);
          identifyAndPunch(finger.fingerID);
        } else {
          Serial.printf("REJECTED: Confidence too low (%d < %d)\n", finger.confidence, MIN_CONFIDENCE_THRESHOLD);
          showStatus("Low quality", "Try again", COL_WARN, STEP_MATCH);
          delay(1200);
          showIdleScreen();
        }
      } else {
        showStatus("Not recognized", "Try again or resync", COL_WARN, STEP_MATCH);
        delay(1200);
        showIdleScreen();
      }
    }
  }
  delay(SCAN_LOOP_DELAY_MS);
}

void handleSerialCommands() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  if (cmd.equalsIgnoreCase("wipe")) {
    Serial.println("Wiping fingerprint library...");
    showStatus("Wiping...", "Please wait", COL_WARN);
    int wipeResult = finger.emptyDatabase();
    Serial.printf("emptyDatabase() returned %d (0 = OK)\n", wipeResult);
    if (wipeResult != FINGERPRINT_OK) {
      showStatus("Wipe FAILED", "Check serial log", COL_ERR);
      return;
    }

    showStatus("Resetting", "backend sync...", COL_WARN);
    bool backendOk = resetBackendSyncState();
    if (!backendOk) {
      Serial.println("WARNING: backend reset failed or unreachable.");
      Serial.println("Sensor is empty but backend still thinks it's synced -");
      Serial.println("pending-sync may report 0 pending. Fix WiFi/backend and");
      Serial.println("type 'wipe' again, or call reset-device-sync manually.");
      showStatus("Backend reset", "FAILED - see log", COL_ERR);
      delay(2000);
      return;
    }

    showStatus("Wipe OK", "Resyncing...", COL_OK);
    syncPendingTemplates();
    showIdleScreen();
  }
}

bool resetBackendSyncState() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Cannot reset backend sync state - WiFi not connected");
    return false;
  }

  StaticJsonDocument<128> doc;
  doc["device_id"] = DEVICE_ID;
  String payload;
  serializeJson(doc, payload);

  HTTPClient http;
  http.begin(String(SERVER_URL) + "/api/device/fingerprints/reset-device-sync");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_API_KEY);
  int code = http.sendRequest("DELETE", payload);
  String respBody = http.getString();
  http.end();

  Serial.printf("reset-device-sync -> HTTP %d: %s\n", code, respBody.c_str());
  return (code == 200);
}

void connectWifi() {
  showStatus("WiFi", "Connecting...", COL_TEXT);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected, IP: ");
    Serial.println(WiFi.localIP());
    showStatus("WiFi OK", WiFi.localIP().toString(), COL_OK);
    delay(800);
  } else {
    Serial.println("WiFi connection failed, will retry.");
    showStatus("WiFi FAILED", "Will retry...", COL_ERR);
  }
}

void flushAndSettleSensor(unsigned long settleMs) {
  while (fingerSerial.available()) fingerSerial.read();
  delay(settleMs);
}

void syncPendingTemplates() {
  if (WiFi.status() != WL_CONNECTED) return;

  showStatus("Syncing...", "Checking for new prints", COL_TEXT, STEP_SYNC);

  HTTPClient http;
  String url = String(SERVER_URL) + "/api/device/fingerprints/pending-sync?device_id=" + DEVICE_ID;
  http.begin(url);
  http.addHeader("x-device-key", DEVICE_API_KEY);

  int code = http.GET();
  if (code != 200) {
    Serial.printf("pending-sync failed, HTTP %d\n", code);
    http.end();
    return;
  }
  String body = http.getString();
  http.end();

  DynamicJsonDocument doc(16384);
  if (deserializeJson(doc, body)) {
    Serial.println("Failed to parse pending-sync response");
    return;
  }

  JsonArray pending = doc["pending"].as<JsonArray>();
  Serial.printf("%d template(s) pending sync\n", pending.size());

  for (JsonObject entry : pending) {
    String employeeId = entry["employee_id"].as<String>();
    String slotLabel = entry["slot_label"].as<String>();
    String templateB64 = entry["template_data"].as<String>();
    String name = entry["name"].as<String>();

    if (entry["existing_local_slot"].isNull()) {
      Serial.printf("Skipping %s - backend did not assign a slot (is the backend updated?)\n", name.c_str());
      continue;
    }
    uint16_t localSlot = entry["existing_local_slot"].as<uint16_t>();

    if (templateB64.length() == 0) {
      Serial.printf("Skipping %s (%s) - no template_data from source device\n", name.c_str(), slotLabel.c_str());
      continue;
    }

    showStatus("Syncing", name, COL_TEXT, STEP_SYNC);

    flushAndSettleSensor(150);

    static uint8_t buf[FP_TEMPLATE_SIZE + 64];
    size_t estimatedLen = (templateB64.length() * 3) / 4;
    if (estimatedLen > sizeof(buf)) {
      Serial.println("Decoded template likely larger than buffer, skipping");
      continue;
    }
    uint16_t len = base64Decode(templateB64, buf, sizeof(buf));
    if (len == 0) {
      Serial.printf("Base64 decode produced 0 bytes for %s, skipping\n", name.c_str());
      continue;
    }

    if (!downloadTemplateBytes(1, buf, len)) {
      Serial.printf("Download to sensor failed for %s\n", name.c_str());
      flushAndSettleSensor(150);
      continue;
    }

    int p = finger.storeModel(localSlot);
    Serial.printf("storeModel(%d) for %s returned code %d (backend-assigned)\n",
                  localSlot, name.c_str(), p);
    if (p != FINGERPRINT_OK) {
      Serial.printf("storeModel failed for %s, code %d\n", name.c_str(), p);
      flushAndSettleSensor(150);
      continue;
    }

    static uint8_t verifyBuf[FP_TEMPLATE_SIZE + 64];
    uint16_t verifyLen = 0;
    bool verifyUploadOk = uploadTemplateBytes(1, verifyBuf, sizeof(verifyBuf), &verifyLen);
    bool integrityOk = false;
    if (!verifyUploadOk) {
      Serial.printf("Could not re-upload slot %d for %s to verify - treating sync as UNCONFIRMED\n", localSlot, name.c_str());
    } else if (verifyLen != len) {
      Serial.printf("Verify LENGTH MISMATCH for %s: sent %d, got %d back - sync REJECTED\n", name.c_str(), len, verifyLen);
    } else {
      int mismatches = 0;
      for (uint16_t i = 0; i < len; i++) {
        if (buf[i] != verifyBuf[i]) mismatches++;
      }
      if (mismatches == 0) {
        integrityOk = true;
        Serial.printf("Verify OK for %s: %d bytes match exactly\n", name.c_str(), len);
      } else {
        Serial.printf("Verify MISMATCH for %s: %d/%d bytes differ - sync REJECTED\n", name.c_str(), mismatches, len);
      }
    }

    if (!integrityOk) {
      Serial.printf("Skipping register-synced for %s - will retry next cycle\n", name.c_str());
      flushAndSettleSensor(150);
      continue;
    }

    bool ok = registerSynced(employeeId, slotLabel, localSlot);
    if (!ok) {
      Serial.printf("register-synced did not confirm for %s - will retry next cycle\n", name.c_str());
    }

    flushAndSettleSensor(300);
  }

  showStatus("Sync done", String(pending.size()) + " checked", COL_OK, STEP_SYNC);
  delay(800);
}

bool registerSynced(const String& employeeId, const String& slotLabel, uint16_t localSlot) {
  StaticJsonDocument<256> doc;
  doc["employee_id"] = employeeId;
  doc["slot_label"] = slotLabel;
  doc["device_id"] = DEVICE_ID;
  doc["sensor_slot_id"] = localSlot;

  String payload;
  serializeJson(doc, payload);

  HTTPClient http;
  http.begin(String(SERVER_URL) + "/api/device/fingerprints/register-synced");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_API_KEY);
  int code = http.POST(payload);
  String response = http.getString();
  http.end();

  Serial.printf("register-synced -> HTTP %d\n", code);
  Serial.println(response);

  return (code == 200 || code == 201);
}

void identifyAndPunch(uint16_t sensorSlotId) {
  HTTPClient http;
  http.begin(String(SERVER_URL) + "/api/device/fingerprints/identify");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_API_KEY);

  StaticJsonDocument<128> reqDoc;
  reqDoc["device_id"] = DEVICE_ID;
  reqDoc["sensor_slot_id"] = sensorSlotId;
  String reqPayload;
  serializeJson(reqDoc, reqPayload);

  int code = http.POST(reqPayload);
  String respBody = http.getString();
  http.end();

  if (code != 200) {
    Serial.printf("identify failed, HTTP %d: %s\n", code, respBody.c_str());
    showStatus("Not found", "Try again or resync", COL_ERR, STEP_VERIFY);
    delay(1500);
    showIdleScreen();
    return;
  }

  StaticJsonDocument<512> respDoc;
  if (deserializeJson(respDoc, respBody)) {
    Serial.println("Failed to parse identify response");
    return;
  }

  String employeeId = respDoc["employee_id"].as<String>();
  String name = respDoc["name"].as<String>();

  showStatus("Welcome", name, COL_OK, STEP_VERIFY);
  punchAttendance(employeeId, name);
}

void punchAttendance(const String& employeeId, const String& name) {
  StaticJsonDocument<128> doc;
  doc["employee_id"] = employeeId;
  doc["device_id"] = DEVICE_ID;
  String payload;
  serializeJson(doc, payload);

  HTTPClient http;
  http.begin(String(SERVER_URL) + "/api/device/attendance/punch");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_API_KEY);
  int code = http.POST(payload);
  String respBody = http.getString();
  http.end();

  Serial.printf("punch -> HTTP %d: %s\n", code, respBody.c_str());

  if (code == 200 || code == 201) {
    lastPunchName = name;
    lastPunchTime = currentTimeString();
    showStatus("Punched in!", name + "  " + lastPunchTime, COL_OK, STEP_SYNC);
  } else {
    // Try to pull a human-readable reason out of the backend's response
    String reason = "Check backend";
    StaticJsonDocument<256> errDoc;
    if (!deserializeJson(errDoc, respBody)) {
      const char* errMsg = errDoc["error"];
      if (errMsg != nullptr) reason = String(errMsg);
    }

    if (code == 403 && reason.indexOf("No shift") >= 0) {
      showStatus("No shift today", name, COL_WARN, STEP_SYNC);
    } else {
      showStatus("Punch failed", reason, COL_ERR, STEP_SYNC);
    }
  }
  delay(1800);
  showIdleScreen();
}
// ─── Raw template transfer ───────────────────────────────────────────────
bool downloadTemplateBytes(uint8_t bufferNo, const uint8_t* buf, uint16_t len) {
  uint8_t cmdData[] = { FINGERPRINT_DOWNLOAD, bufferNo };
  Adafruit_Fingerprint_Packet cmd(FINGERPRINT_COMMANDPACKET, sizeof(cmdData), cmdData);
  finger.writeStructuredPacket(cmd);

  uint8_t ackDummy[1] = {0};
  Adafruit_Fingerprint_Packet ack(FINGERPRINT_ACKPACKET, 1, ackDummy);
  if (finger.getStructuredPacket(&ack) != FINGERPRINT_OK || ack.data[0] != FINGERPRINT_OK) {
    Serial.println("Download command rejected by sensor");
    return false;
  }

  uint16_t chunkSize = finger.packet_len > 0 ? finger.packet_len : 32;
  uint16_t sent = 0;
  while (sent < len) {
    uint16_t remaining = len - sent;
    uint16_t thisChunk = remaining > chunkSize ? chunkSize : remaining;
    bool isLast = (sent + thisChunk) >= len;
    uint8_t type = isLast ? FINGERPRINT_ENDDATAPACKET : FINGERPRINT_DATAPACKET;

    Adafruit_Fingerprint_Packet dataPkt(type, thisChunk, (uint8_t*)(buf + sent));
    finger.writeStructuredPacket(dataPkt);
    sent += thisChunk;
    delay(5);
  }
  delay(100);

  return true;
}

bool uploadTemplateBytes(uint8_t bufferNo, uint8_t* outBuf, uint16_t maxLen, uint16_t* outLen) {
  uint8_t cmdData[] = { FINGERPRINT_UPLOAD, bufferNo };
  Adafruit_Fingerprint_Packet cmd(FINGERPRINT_COMMANDPACKET, sizeof(cmdData), cmdData);
  finger.writeStructuredPacket(cmd);

  uint8_t ackDummy[1] = {0};
  Adafruit_Fingerprint_Packet ack(FINGERPRINT_ACKPACKET, 1, ackDummy);
  int ackResult = finger.getStructuredPacket(&ack);
  if (ackResult != FINGERPRINT_OK || ack.data[0] != FINGERPRINT_OK) {
    Serial.println("Upload command rejected by sensor (verify step)");
    return false;
  }

  uint16_t total = 0;
  uint8_t dataDummy[1] = {0};
  Adafruit_Fingerprint_Packet dataPkt(FINGERPRINT_DATAPACKET, 1, dataDummy);

  do {
    int result = finger.getStructuredPacket(&dataPkt);
    if (result != FINGERPRINT_OK) {
      Serial.println("Error reading template data packet during verify");
      return false;
    }
    uint16_t chunkLen = dataPkt.length - 2;
    if (total + chunkLen > maxLen) {
      Serial.println("Verify buffer too small for this sensor's template size");
      return false;
    }
    memcpy(outBuf + total, dataPkt.data, chunkLen);
    total += chunkLen;
  } while (dataPkt.type != FINGERPRINT_ENDDATAPACKET);

  *outLen = total;
  return true;
}
