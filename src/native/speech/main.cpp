#include "vendor/transcribe.h"
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

static void quiet(transcribe_log_level, const char *, void *) {}
static void json(const std::string &text) {
  static const char *hex = "0123456789abcdef";
  std::cout << '"';
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') std::cout << '\\' << c;
    else if (c < 32) std::cout << "\\u00" << hex[c >> 4] << hex[c & 15];
    else std::cout << c;
  }
  std::cout << '"';
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  if (std::string(argv[1]) == "--version") {
    std::cout << "{\"engine\":\"transcribe.cpp\",\"version\":";
    json(transcribe_version()); std::cout << "}\n"; return 0;
  }
  std::vector<unsigned char> input;
  char block[8192];
  while (std::cin.read(block, sizeof(block)) || std::cin.gcount()) {
    if (input.size() + std::cin.gcount() > 960000) return 3;
    input.insert(input.end(), block, block + std::cin.gcount());
  }
  if (input.size() < 6400 || input.size() % 2) return 3;
  std::vector<float> pcm(input.size() / 2);
  for (size_t i = 0; i < pcm.size(); i++) {
    const int16_t sample = static_cast<int16_t>(static_cast<uint16_t>(input[i*2]) | (static_cast<uint16_t>(input[i*2+1]) << 8));
    pcm[i] = sample / 32768.0f;
  }
  std::fill(input.begin(), input.end(), 0);
  transcribe_log_set(quiet, nullptr);
  if (transcribe_init_backends_default() != TRANSCRIBE_OK) return 4;
  transcribe_session *session = nullptr;
  if (transcribe_open(argv[1], nullptr, nullptr, &session) != TRANSCRIBE_OK) return 5;
  const auto result = transcribe_run(session, pcm.data(), static_cast<int>(pcm.size()), nullptr);
  std::fill(pcm.begin(), pcm.end(), 0);
  if (result != TRANSCRIBE_OK) { transcribe_session_free(session); return 6; }
  const char *text = transcribe_full_text(session);
  std::cout << "{\"model\":"; json(argv[1]);
  std::cout << ",\"text\":"; json(text ? text : ""); std::cout << "}\n";
  transcribe_session_free(session);
  return 0;
}
