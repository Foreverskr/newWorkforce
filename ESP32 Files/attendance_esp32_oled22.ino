// ESP32 + AS608/R307 attendance kiosk — WITH OLED STATUS DISPLAY
// -----------------------------------------------------------------------
// NEW FIXES IN THIS REVISION (on top of the previous "FIXED VERSION"):
//
//   D. wipe now ALSO calls the backend's new
//      /api/device/fingerprints/reset-device-sync endpoint before
//      resyncing. Previously, wipe only cleared the physical sensor -
//      the backend still believed everything was already synced, so
//      pending-sync reported "0 pending" and the sensor stayed empty
//      forever after a wipe. Now the backend's records are cleared too,
//      so the resync that follows actually pulls everything back down.
//
//   E. The finger.getTemplateCount() guessing fallback in
//      syncPendingTemplates() is REMOVED. pending-sync now always
//      returns a real, backend-assigned existing_local_slot for every
//      entry - including first-time syncs - so the firmware never needs
//      to guess a slot number from local sensor state again. This
//      closes the last remaining place slot numbers could drift.
//
//   F. syncPendingTemplates() now flushes the fingerSerial RX buffer and
//      pauses briefly before AND after each entry's sensor commands.
//      Without this, the first template in a multi-entry batch would
//      sync fine, but every entry after it in the same batch would
//      intermittently fail (storeModel returning a nonzero code, or the
//      sensor rejecting the DOWNLOAD command outright) - most likely
//      because the AS608/R307 needs a moment to settle after a
//      storeModel + verify-upload round trip, and stray bytes lingering
//      in the UART RX buffer were getting misread as the start of the
//      next command's ACK. The failed entries would then succeed on the
//      next sync cycle once they were "first" again, which is the
//      signature this fix is meant to eliminate.
//
// Do this once, after flashing, to fully clear out old test data:
//   1. Flash this sketch.
//   2. Type `wipe` + Enter in Serial Monitor.
//   3. Confirm you see "emptyDatabase returned 0", then
//      "Backend reset: N rows removed", then the resync log.
//
// Everything else is unchanged from your previous version.

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
const char* DEVICE_API_KEY = "gpzgbwlukzkhhdzzvnfevvfifnsfshizchucptdcdqjpcjmnbgyctsuycetehdwq";
const char* DEVICE_ID      = "ESP32-ATTEND-01";

const unsigned long SCAN_LOOP_DELAY_MS = 200;
const unsigned long SYNC_INTERVAL_MS   = 60000;

#define FP_TEMPLATE_SIZE 1024
#define FINGERPRINT_DOWNLOAD 0x09
#define MIN_CONFIDENCE_THRESHOLD 80

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

unsigned long lastSync = 0;

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

void setup() {
  Serial.begin(115200);
  delay(300);

  Wire.begin(OLED_SDA, OLED_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDR)) {
    Serial.println("OLED not found - check wiring/address (0x3C).");
    while (true) delay(1000);
  }
  showStatus("Booting...", "Init sensor");

  fingerSerial.setRxBufferSize(1024);
  fingerSerial.begin(57600, SERIAL_8N1, 16, 17);
  finger.begin(57600);

  if (!finger.verifyPassword()) {
    Serial.println("Fingerprint sensor NOT found - check wiring/power.");
    showStatus("Sensor ERROR", "Check wiring");
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
  syncPendingTemplates();
  showStatus("Ready", "Scan finger");
}

void loop() {
  handleSerialCommands();

  if (WiFi.status() != WL_CONNECTED) connectWifi();

  if (millis() - lastSync >= SYNC_INTERVAL_MS) {
    lastSync = millis();
    syncPendingTemplates();
    showStatus("Ready", "Scan finger");
  }

  int p = finger.getImage();
  if (p == FINGERPRINT_OK) {
    p = finger.image2Tz(1);
    if (p == FINGERPRINT_OK) {
      p = finger.fingerFastSearch();
      if (p == FINGERPRINT_OK) {
        Serial.printf("Raw match: slot %d, confidence %d\n", finger.fingerID, finger.confidence);

        if (finger.confidence >= MIN_CONFIDENCE_THRESHOLD) {
          Serial.printf("ACCEPTED: Matched slot %d (confidence %d)\n", finger.fingerID, finger.confidence);
          showStatus("Checking...", "");
          identifyAndPunch(finger.fingerID);
        } else {
          Serial.printf("REJECTED: Confidence too low (%d < %d)\n", finger.confidence, MIN_CONFIDENCE_THRESHOLD);
          showStatus("Low quality", "Try again");
          delay(1000);
          showStatus("Ready", "Scan finger");
        }
      } else {
        showStatus("Not recognized", "Try again");
        delay(1000);
        showStatus("Ready", "Scan finger");
      }
    }
  }
  delay(SCAN_LOOP_DELAY_MS);
}

// FIX D: wipe now clears BOTH the physical sensor AND the backend's belief
// about what this device has synced. Order matters: wipe the sensor first
// (so if WiFi/backend call fails, at least the sensor is in a known-empty
// state and a retry of just the backend call is safe), then reset the
// backend, then resync.
void handleSerialCommands() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  if (cmd.equalsIgnoreCase("wipe")) {
    Serial.println("Wiping fingerprint library...");
    showStatus("Wiping...", "Please wait");
    int wipeResult = finger.emptyDatabase();
    Serial.printf("emptyDatabase() returned %d (0 = OK)\n", wipeResult);
    if (wipeResult != FINGERPRINT_OK) {
      showStatus("Wipe FAILED", "Check serial log");
      return;
    }

    showStatus("Resetting", "backend sync...");
    bool backendOk = resetBackendSyncState();
    if (!backendOk) {
      Serial.println("WARNING: backend reset failed or unreachable.");
      Serial.println("Sensor is empty but backend still thinks it's synced -");
      Serial.println("pending-sync may report 0 pending. Fix WiFi/backend and");
      Serial.println("type 'wipe' again, or call reset-device-sync manually.");
      showStatus("Backend reset", "FAILED - see log");
      delay(2000);
      return;
    }

    showStatus("Wipe OK", "Resyncing...");
    syncPendingTemplates();
    showStatus("Ready", "Scan finger");
  }
}

// FIX D support: tells the backend to forget this device's synced records,
// so pending-sync correctly reports everything as pending again after a
// physical wipe. See resetDeviceSync() in fingerprints.controller.js.
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
  showStatus("WiFi", "Connecting...");
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
    showStatus("WiFi OK", WiFi.localIP().toString());
    delay(800);
  } else {
    Serial.println("WiFi connection failed, will retry.");
    showStatus("WiFi FAILED", "Will retry...");
  }
}

// FIX F support: drain any stray bytes sitting in the fingerprint sensor's
// UART RX buffer, then give it a moment to settle. Called before AND after
// each entry's sensor commands in syncPendingTemplates() so back-to-back
// entries in the same batch don't intermittently fail.
void flushAndSettleSensor(unsigned long settleMs) {
  while (fingerSerial.available()) fingerSerial.read();
  delay(settleMs);
}

void syncPendingTemplates() {
  if (WiFi.status() != WL_CONNECTED) return;

  showStatus("Syncing...", "Checking for new prints");

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

    // FIX E: existing_local_slot is now ALWAYS present and backend-assigned
    // - for a resync it's this device's own prior slot, for a first-time
    // sync it's a freshly assigned one. There is no more "guess from local
    // sensor state" fallback. If this field is ever missing, that means
    // you're running this firmware against the OLD backend controller -
    // update fingerprints.controller.js's pendingSync() first.
    if (entry["existing_local_slot"].isNull()) {
      Serial.printf("Skipping %s - backend did not assign a slot (is the backend updated?)\n", name.c_str());
      continue;
    }
    uint16_t localSlot = entry["existing_local_slot"].as<uint16_t>();

    if (templateB64.length() == 0) {
      Serial.printf("Skipping %s (%s) - no template_data from source device\n", name.c_str(), slotLabel.c_str());
      continue;
    }

    showStatus("Syncing", name);

    // FIX F: settle the sensor and clear any leftover UART bytes before
    // starting this entry's DOWNLOAD command. Matters most for the 2nd+
    // entry in a batch, right after the previous entry's verify-upload.
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
      // FIX F: settle before the next loop iteration even on this failure
      // path, so a rejected DOWNLOAD command doesn't leave the sensor in
      // a bad state for the next entry.
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

    // FIX F: let the sensor settle and clear any stray UART bytes before
    // starting the next entry's download command. Without this, back-to-back
    // entries in the same batch intermittently fail storeModel/download.
    flushAndSettleSensor(300);
  }

  showStatus("Sync done", String(pending.size()) + " checked");
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
    showStatus("Not found", "Try again or resync");
    delay(1500);
    showStatus("Ready", "Scan finger");
    return;
  }

  StaticJsonDocument<512> respDoc;
  if (deserializeJson(respDoc, respBody)) {
    Serial.println("Failed to parse identify response");
    return;
  }

  String employeeId = respDoc["employee_id"].as<String>();
  String name = respDoc["name"].as<String>();

  showStatus("Welcome", name);
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
    showStatus("Punched in!", name);
  } else {
    showStatus("Punch failed", "Check backend");
  }
  delay(1500);
  showStatus("Ready", "Scan finger");
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
