#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiUdp.h>

// Forward declarations
void sendWOL();
void connectWiFi();
bool checkWakeCommand();

// WiFi credentials
const char* WIFI_SSID = "wifi_casa";
const char* WIFI_PASS = "de01adez";

// GCS public URL for state file
const char* STATE_URL = "https://storage.googleapis.com/lein-wol/state.txt";

// Mac's MAC address for Wake on LAN
const uint8_t MAC_ADDR[] = {0x2C, 0xCA, 0x16, 0x49, 0xDF, 0xE5};

// Poll interval in milliseconds
const unsigned long POLL_INTERVAL = 5000;

WiFiUDP udp;
unsigned long lastPoll = 0;

void sendWOL() {
  uint8_t packet[102];

  // 6 bytes of 0xFF
  for (int i = 0; i < 6; i++) {
    packet[i] = 0xFF;
  }

  // 16 repetitions of MAC address
  for (int i = 0; i < 16; i++) {
    for (int j = 0; j < 6; j++) {
      packet[6 + i * 6 + j] = MAC_ADDR[j];
    }
  }

  // Send to broadcast address on port 9
  udp.beginPacket(IPAddress(255, 255, 255, 255), 9);
  udp.write(packet, sizeof(packet));
  udp.endPacket();

  Serial.println("WOL magic packet sent!");
}

void connectWiFi() {
  Serial.printf("Connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nConnected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nFailed to connect. Restarting...");
    ESP.restart();
  }
}

bool checkWakeCommand() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  HTTPClient http;
  // Add cache-busting query param so GCS doesn't serve cached response
  String url = String(STATE_URL) + "?t=" + String(millis());
  http.begin(url);
  http.setTimeout(5000);

  int code = http.GET();
  if (code == 200) {
    String body = http.getString();
    body.trim();
    http.end();

    if (body == "wake") {
      Serial.println("Wake command received!");
      return true;
    }
    return false;
  }

  Serial.printf("Poll failed: %d\n", code);
  http.end();
  return false;
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== Lein WOL Bridge ===");
  connectWiFi();
}

void loop() {
  unsigned long now = millis();

  if (now - lastPoll >= POLL_INTERVAL) {
    lastPoll = now;

    if (checkWakeCommand()) {
      // Send WOL multiple times for reliability
      for (int i = 0; i < 3; i++) {
        sendWOL();
        delay(100);
      }
      // Wait before checking again to avoid re-triggering
      delay(30000);
    }
  }
}
