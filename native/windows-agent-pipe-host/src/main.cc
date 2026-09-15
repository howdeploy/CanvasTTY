#define _WIN32_WINNT 0x0600
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <fcntl.h>
#include <io.h>

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

constexpr std::uint32_t kRelayMagic = 0x48505443;
constexpr std::uint8_t kRelayVersion = 1;
constexpr std::size_t kHeaderBytes = 16;
constexpr std::uint32_t kMaxPayloadBytes = 512 * 1024 + 1;
constexpr std::size_t kMaxQueuedWriteBytes = 4 * kMaxPayloadBytes;
constexpr DWORD kPipeBufferBytes = 64 * 1024;

enum class FrameType : std::uint8_t {
  kReady = 1,
  kConnect = 2,
  kData = 3,
  kClose = 4,
  kFatal = 5,
  kWrite = 16,
  kDestroy = 17,
  kShutdown = 18,
};

HANDLE g_shutdown_event = nullptr;
HANDLE g_main_thread = nullptr;
std::mutex g_stdout_mutex;

void StoreU32(std::uint8_t* destination, std::uint32_t value) {
  destination[0] = static_cast<std::uint8_t>(value & 0xff);
  destination[1] = static_cast<std::uint8_t>((value >> 8) & 0xff);
  destination[2] = static_cast<std::uint8_t>((value >> 16) & 0xff);
  destination[3] = static_cast<std::uint8_t>((value >> 24) & 0xff);
}

std::uint32_t LoadU32(const std::uint8_t* source) {
  return static_cast<std::uint32_t>(source[0]) |
         (static_cast<std::uint32_t>(source[1]) << 8) |
         (static_cast<std::uint32_t>(source[2]) << 16) |
         (static_cast<std::uint32_t>(source[3]) << 24);
}

bool WriteAll(HANDLE handle, const std::uint8_t* bytes, std::size_t length) {
  while (length > 0) {
    DWORD written = 0;
    const DWORD chunk = static_cast<DWORD>(length > MAXDWORD ? MAXDWORD : length);
    if (!WriteFile(handle, bytes, chunk, &written, nullptr) || written == 0) return false;
    bytes += written;
    length -= written;
  }
  return true;
}

bool SendFrame(FrameType type, std::uint32_t connection_id, const std::uint8_t* payload,
               std::uint32_t payload_length) {
  if (payload_length > kMaxPayloadBytes) return false;
  std::array<std::uint8_t, kHeaderBytes> header{};
  StoreU32(header.data(), kRelayMagic);
  header[4] = kRelayVersion;
  header[5] = static_cast<std::uint8_t>(type);
  StoreU32(header.data() + 8, connection_id);
  StoreU32(header.data() + 12, payload_length);
  std::scoped_lock lock(g_stdout_mutex);
  const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  return WriteAll(output, header.data(), header.size()) &&
         (payload_length == 0 || WriteAll(output, payload, payload_length));
}

bool SendTextFrame(FrameType type, const std::string& text) {
  const std::size_t bounded = text.size() > 1024 ? 1024 : text.size();
  return SendFrame(type, 0, reinterpret_cast<const std::uint8_t*>(text.data()),
                   static_cast<std::uint32_t>(bounded));
}

void SignalShutdown() {
  if (g_shutdown_event != nullptr) SetEvent(g_shutdown_event);
  if (g_main_thread != nullptr) CancelSynchronousIo(g_main_thread);
}

class CurrentUserSecurity {
 public:
  bool Initialize() {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    DWORD required = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &required);
    if (required == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
      CloseHandle(token);
      return false;
    }
    token_user_.resize(required);
    if (!GetTokenInformation(token, TokenUser, token_user_.data(), required, &required)) {
      CloseHandle(token);
      return false;
    }
    CloseHandle(token);

    user_sid_ = reinterpret_cast<TOKEN_USER*>(token_user_.data())->User.Sid;
    if (!IsValidSid(user_sid_)) return false;
    const DWORD sid_length = GetLengthSid(user_sid_);
    const DWORD acl_length = sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + sid_length;
    acl_.resize(acl_length);
    auto* acl = reinterpret_cast<PACL>(acl_.data());
    if (!InitializeAcl(acl, acl_length, ACL_REVISION)) return false;
    if (!AddAccessAllowedAceEx(acl, ACL_REVISION, 0, GENERIC_ALL, user_sid_)) return false;
    if (!InitializeSecurityDescriptor(&descriptor_, SECURITY_DESCRIPTOR_REVISION)) return false;
    if (!SetSecurityDescriptorControl(&descriptor_, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) return false;
    if (!SetSecurityDescriptorDacl(&descriptor_, TRUE, acl, FALSE)) return false;

    attributes_.nLength = sizeof(attributes_);
    attributes_.lpSecurityDescriptor = &descriptor_;
    attributes_.bInheritHandle = FALSE;
    return true;
  }

  SECURITY_ATTRIBUTES* attributes() { return &attributes_; }
  PSID user_sid() const { return user_sid_; }

 private:
  std::vector<std::uint8_t> token_user_;
  std::vector<std::uint8_t> acl_;
  SECURITY_DESCRIPTOR descriptor_{};
  SECURITY_ATTRIBUTES attributes_{};
  PSID user_sid_ = nullptr;
};

std::wstring RandomPipeName() {
  std::array<std::uint8_t, 16> random{};
  if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    return {};
  }
  constexpr wchar_t kHex[] = L"0123456789abcdef";
  std::wstring result = L"\\\\.\\pipe\\canvastty-agent-";
  result.reserve(result.size() + random.size() * 2);
  for (const auto byte : random) {
    result.push_back(kHex[byte >> 4]);
    result.push_back(kHex[byte & 0x0f]);
  }
  return result;
}

std::string NarrowPipeName(const std::wstring& value) {
  std::string result;
  result.reserve(value.size());
  for (const wchar_t character : value) {
    if (character > 0x7f) return {};
    result.push_back(static_cast<char>(character));
  }
  return result;
}

HANDLE CreateSecurePipe(const std::wstring& name, CurrentUserSecurity& security,
                        bool first_instance) {
  DWORD open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
  if (first_instance) open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
  return CreateNamedPipeW(
      name.c_str(), open_mode,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      PIPE_UNLIMITED_INSTANCES, kPipeBufferBytes, kPipeBufferBytes, 0, security.attributes());
}

bool WaitForOverlapped(HANDLE handle, OVERLAPPED& overlapped, DWORD* transferred,
                       HANDLE connection_close_event = nullptr) {
  HANDLE waits[] = {overlapped.hEvent, g_shutdown_event, connection_close_event};
  const DWORD count = connection_close_event == nullptr ? 2 : 3;
  const DWORD status = WaitForMultipleObjects(count, waits, FALSE, INFINITE);
  if (status == WAIT_OBJECT_0) {
    return GetOverlappedResult(handle, &overlapped, transferred, FALSE) != FALSE;
  }
  CancelIoEx(handle, &overlapped);
  WaitForSingleObject(overlapped.hEvent, INFINITE);
  GetOverlappedResult(handle, &overlapped, transferred, FALSE);
  SetLastError(ERROR_OPERATION_ABORTED);
  return false;
}

bool FinishOverlapped(HANDLE handle, OVERLAPPED& overlapped, BOOL completed,
                      DWORD start_error, DWORD* transferred,
                      HANDLE connection_close_event = nullptr) {
  if (completed) {
    return GetOverlappedResult(handle, &overlapped, transferred, FALSE) != FALSE;
  }
  if (start_error == ERROR_IO_PENDING) {
    return WaitForOverlapped(handle, overlapped, transferred, connection_close_event);
  }
  SetLastError(start_error);
  return false;
}

bool ConnectPipe(HANDLE pipe) {
  OVERLAPPED overlapped{};
  overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (overlapped.hEvent == nullptr) return false;
  bool connected = false;
  if (ConnectNamedPipe(pipe, &overlapped)) {
    connected = true;
  } else {
    const DWORD error = GetLastError();
    if (error == ERROR_PIPE_CONNECTED) {
      connected = true;
    } else if (error == ERROR_IO_PENDING) {
      DWORD ignored = 0;
      connected = WaitForOverlapped(pipe, overlapped, &ignored);
    }
  }
  CloseHandle(overlapped.hEvent);
  return connected;
}

struct Connection {
  Connection(std::uint32_t new_id, HANDLE new_pipe)
      : id(new_id), pipe(new_pipe), close_event(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ~Connection() {
    if (close_event != nullptr) CloseHandle(close_event);
  }
  std::uint32_t id;
  HANDLE pipe;
  HANDLE close_event;
  std::atomic<bool> closing{false};
  std::atomic<int> active_workers{2};
  std::mutex write_mutex;
  std::mutex queue_mutex;
  std::condition_variable queue_changed;
  std::deque<std::vector<std::uint8_t>> write_queue;
  std::size_t queued_write_bytes = 0;
};

std::mutex g_connections_mutex;
std::unordered_map<std::uint32_t, std::shared_ptr<Connection>> g_connections;
std::mutex g_client_threads_mutex;
std::vector<std::thread> g_client_threads;
std::atomic<std::uint32_t> g_next_connection_id{1};

std::shared_ptr<Connection> FindConnection(std::uint32_t id) {
  std::scoped_lock lock(g_connections_mutex);
  const auto iterator = g_connections.find(id);
  return iterator == g_connections.end() ? nullptr : iterator->second;
}

void MarkClosing(const std::shared_ptr<Connection>& connection) {
  if (connection == nullptr || connection->closing.exchange(true)) return;
  if (connection->close_event != nullptr) SetEvent(connection->close_event);
  connection->queue_changed.notify_all();
}

void CloseConnection(const std::shared_ptr<Connection>& connection) {
  {
    std::scoped_lock lock(connection->write_mutex);
    connection->closing.store(true);
    if (connection->pipe != INVALID_HANDLE_VALUE) {
      CancelIoEx(connection->pipe, nullptr);
      DisconnectNamedPipe(connection->pipe);
      CloseHandle(connection->pipe);
      connection->pipe = INVALID_HANDLE_VALUE;
    }
  }
  std::scoped_lock map_lock(g_connections_mutex);
  const auto iterator = g_connections.find(connection->id);
  if (iterator != g_connections.end() && iterator->second == connection) {
    g_connections.erase(iterator);
  }
}

bool WriteConnection(const std::shared_ptr<Connection>& connection, const std::uint8_t* payload,
                     std::uint32_t length) {
  std::scoped_lock lock(connection->write_mutex);
  if (connection->closing.load() || connection->pipe == INVALID_HANDLE_VALUE) return false;
  std::uint32_t offset = 0;
  while (offset < length) {
    OVERLAPPED overlapped{};
    overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (overlapped.hEvent == nullptr) return false;
    DWORD written = 0;
    const BOOL completed = WriteFile(
        connection->pipe, payload + offset, length - offset, nullptr, &overlapped);
    const DWORD start_error = completed ? ERROR_SUCCESS : GetLastError();
    const bool success = FinishOverlapped(
        connection->pipe, overlapped, completed, start_error, &written, connection->close_event);
    CloseHandle(overlapped.hEvent);
    if (!success || written == 0) return false;
    offset += written;
  }
  return true;
}

bool EnqueueWrite(const std::shared_ptr<Connection>& connection, const std::uint8_t* payload,
                  std::uint32_t length) {
  if (connection == nullptr || connection->closing.load()) return false;
  std::scoped_lock lock(connection->queue_mutex);
  if (connection->closing.load() ||
      connection->queued_write_bytes + length > kMaxQueuedWriteBytes) {
    return false;
  }
  connection->write_queue.emplace_back(payload, payload + length);
  connection->queued_write_bytes += length;
  connection->queue_changed.notify_one();
  return true;
}

void WorkerDone(const std::shared_ptr<Connection>& connection) {
  if (connection->active_workers.fetch_sub(1) == 1) CloseConnection(connection);
}

void WriteClient(const std::shared_ptr<Connection>& connection) {
  for (;;) {
    std::vector<std::uint8_t> payload;
    {
      std::unique_lock lock(connection->queue_mutex);
      connection->queue_changed.wait(lock, [&]() {
        return connection->closing.load() ||
               WaitForSingleObject(g_shutdown_event, 0) == WAIT_OBJECT_0 ||
               !connection->write_queue.empty();
      });
      if (connection->closing.load() || WaitForSingleObject(g_shutdown_event, 0) == WAIT_OBJECT_0) {
        break;
      }
      payload = std::move(connection->write_queue.front());
      connection->write_queue.pop_front();
      connection->queued_write_bytes -= payload.size();
    }
    if (!WriteConnection(connection, payload.data(), static_cast<std::uint32_t>(payload.size()))) {
      MarkClosing(connection);
      break;
    }
  }
  WorkerDone(connection);
}

void ReadClient(const std::shared_ptr<Connection>& connection) {
  std::array<std::uint8_t, kPipeBufferBytes> buffer{};
  while (!connection->closing.load() && WaitForSingleObject(g_shutdown_event, 0) != WAIT_OBJECT_0) {
    OVERLAPPED overlapped{};
    overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (overlapped.hEvent == nullptr) break;
    DWORD bytes_read = 0;
    const BOOL completed = ReadFile(
        connection->pipe, buffer.data(), static_cast<DWORD>(buffer.size()), nullptr, &overlapped);
    const DWORD start_error = completed ? ERROR_SUCCESS : GetLastError();
    const bool success = FinishOverlapped(
        connection->pipe, overlapped, completed, start_error, &bytes_read, connection->close_event);
    CloseHandle(overlapped.hEvent);
    if (!success || bytes_read == 0) break;
    if (!SendFrame(FrameType::kData, connection->id, buffer.data(), bytes_read)) {
      SignalShutdown();
      break;
    }
  }
  SendFrame(FrameType::kClose, connection->id, nullptr, 0);
  MarkClosing(connection);
  WorkerDone(connection);
}

void StartClient(HANDLE pipe) {
  std::uint32_t id = g_next_connection_id.fetch_add(1);
  if (id == 0) id = g_next_connection_id.fetch_add(1);
  auto connection = std::make_shared<Connection>(id, pipe);
  if (connection->close_event == nullptr) {
    DisconnectNamedPipe(pipe);
    CloseHandle(pipe);
    SignalShutdown();
    return;
  }
  {
    std::scoped_lock lock(g_connections_mutex);
    g_connections.emplace(id, connection);
  }
  if (!SendFrame(FrameType::kConnect, id, nullptr, 0)) {
    CloseConnection(connection);
    SignalShutdown();
    return;
  }
  std::scoped_lock lock(g_client_threads_mutex);
  // A terminated std::thread keeps its HANDLE until join(), so without this the host would
  // accumulate two thread handles per connection for its whole lifetime. Reap the signalled
  // ones here, under the same mutex, before adding this connection's workers.
  for (auto iterator = g_client_threads.begin(); iterator != g_client_threads.end();) {
    const HANDLE thread_handle = static_cast<HANDLE>(iterator->native_handle());
    if (WaitForSingleObject(thread_handle, 0) != WAIT_OBJECT_0) {
      ++iterator;
      continue;
    }
    iterator->join();
    iterator = g_client_threads.erase(iterator);
  }
  g_client_threads.emplace_back([connection]() { ReadClient(connection); });
  g_client_threads.emplace_back([connection]() { WriteClient(connection); });
}

void AcceptClients(const std::wstring& name, CurrentUserSecurity& security) {
  HANDLE listener = CreateSecurePipe(name, security, true);
  if (listener == INVALID_HANDLE_VALUE) {
    SendTextFrame(FrameType::kFatal, "CreateNamedPipeW failed before READY.");
    SignalShutdown();
    return;
  }
  const std::string endpoint = NarrowPipeName(name);
  if (endpoint.empty() || !SendTextFrame(FrameType::kReady, endpoint)) {
    CloseHandle(listener);
    SignalShutdown();
    return;
  }

  while (WaitForSingleObject(g_shutdown_event, 0) != WAIT_OBJECT_0) {
    if (!ConnectPipe(listener)) {
      CloseHandle(listener);
      if (WaitForSingleObject(g_shutdown_event, 0) != WAIT_OBJECT_0) {
        SendTextFrame(FrameType::kFatal, "ConnectNamedPipe failed.");
        SignalShutdown();
      }
      return;
    }
    // The protected DACL is the authorization boundary for every pipe instance.
    // ImpersonateNamedPipeClient cannot authenticate a newly connected client here because
    // Windows derives that context from the last message read, and no message has been read yet.
    HANDLE replacement = CreateSecurePipe(name, security, false);
    if (replacement == INVALID_HANDLE_VALUE) {
      DisconnectNamedPipe(listener);
      CloseHandle(listener);
      SendTextFrame(FrameType::kFatal, "Could not create the next protected pipe instance.");
      SignalShutdown();
      return;
    }
    StartClient(listener);
    listener = replacement;
  }
  CancelIoEx(listener, nullptr);
  CloseHandle(listener);
}

class InputFrameDecoder {
 public:
  bool Push(const std::uint8_t* chunk, std::size_t length) {
    buffer_.insert(buffer_.end(), chunk, chunk + length);
    for (;;) {
      if (buffer_.size() < kHeaderBytes) return true;
      if (LoadU32(buffer_.data()) != kRelayMagic || buffer_[4] != kRelayVersion ||
          buffer_[6] != 0 || buffer_[7] != 0) {
        SendTextFrame(FrameType::kFatal, "Invalid relay header from Electron.");
        return false;
      }
      const std::uint32_t payload_length = LoadU32(buffer_.data() + 12);
      if (payload_length > kMaxPayloadBytes) {
        SendTextFrame(FrameType::kFatal, "Relay frame from Electron exceeded the payload bound.");
        return false;
      }
      const std::size_t frame_length = kHeaderBytes + payload_length;
      if (buffer_.size() < frame_length) return true;
      const auto type = static_cast<FrameType>(buffer_[5]);
      const std::uint32_t connection_id = LoadU32(buffer_.data() + 8);
      const std::uint8_t* payload = buffer_.data() + kHeaderBytes;
      if (!Dispatch(type, connection_id, payload, payload_length)) return false;
      buffer_.erase(buffer_.begin(), buffer_.begin() + static_cast<std::ptrdiff_t>(frame_length));
    }
  }

 private:
  bool Dispatch(FrameType type, std::uint32_t connection_id, const std::uint8_t* payload,
                std::uint32_t payload_length) {
    if (type == FrameType::kShutdown) {
      if (connection_id != 0 || payload_length != 0) return ProtocolFailure();
      return false;
    }
    if (connection_id == 0) return ProtocolFailure();
    const auto connection = FindConnection(connection_id);
    if (type == FrameType::kDestroy) {
      if (payload_length != 0) return ProtocolFailure();
      MarkClosing(connection);
      return true;
    }
    if (type == FrameType::kWrite) {
      if (payload_length == 0) return true;
      if (!EnqueueWrite(connection, payload, payload_length)) {
        MarkClosing(connection);
      }
      return true;
    }
    return ProtocolFailure();
  }

  bool ProtocolFailure() {
    SendTextFrame(FrameType::kFatal, "Invalid relay command from Electron.");
    return false;
  }

  std::vector<std::uint8_t> buffer_;
};

bool VerifyPipeDacl(HANDLE pipe, PSID expected_sid) {
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD status = GetSecurityInfo(pipe, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION,
                                       nullptr, nullptr, &dacl, nullptr, &descriptor);
  if (status != ERROR_SUCCESS || dacl == nullptr || dacl->AceCount != 1) {
    if (descriptor != nullptr) LocalFree(descriptor);
    return false;
  }
  void* raw_ace = nullptr;
  bool valid = false;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  const bool protected_dacl = GetSecurityDescriptorControl(descriptor, &control, &revision) &&
                              (control & SE_DACL_PROTECTED) != 0;
  if (GetAce(dacl, 0, &raw_ace)) {
    const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw_ace);
    const PSID sid = const_cast<DWORD*>(&ace->SidStart);
    const bool full_access = ace->Mask == GENERIC_ALL || ace->Mask == FILE_ALL_ACCESS;
    valid = protected_dacl && ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE &&
            ace->Header.AceFlags == 0 && full_access && IsValidSid(sid) &&
            EqualSid(sid, expected_sid);
  }
  LocalFree(descriptor);
  return valid;
}

bool SelfTestFailure(const char* stage, DWORD error = ERROR_SUCCESS) {
  std::fprintf(stderr, "CanvasTTY pipe host self-test failed at %s (win32=%lu).\n",
               stage, static_cast<unsigned long>(error));
  return false;
}

bool SelfTest() {
  CurrentUserSecurity security;
  if (!security.Initialize()) return SelfTestFailure("security.initialize", GetLastError());
  const std::wstring name = RandomPipeName();
  if (name.empty()) return SelfTestFailure("pipe.random-name");
  HANDLE first = CreateSecurePipe(name, security, true);
  if (first == INVALID_HANDLE_VALUE) return SelfTestFailure("pipe.create-first", GetLastError());
  if (!VerifyPipeDacl(first, security.user_sid())) {
    CloseHandle(first);
    return SelfTestFailure("pipe.verify-dacl");
  }
  HANDLE duplicate_first = CreateSecurePipe(name, security, true);
  if (duplicate_first != INVALID_HANDLE_VALUE) {
    CloseHandle(duplicate_first);
    CloseHandle(first);
    return SelfTestFailure("pipe.duplicate-first-succeeded");
  }
  const DWORD duplicate_error = GetLastError();
  if (duplicate_error != ERROR_ACCESS_DENIED) {
    CloseHandle(first);
    return SelfTestFailure("pipe.duplicate-first-error", duplicate_error);
  }
  HANDLE second = CreateSecurePipe(name, security, false);
  if (second == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    CloseHandle(first);
    return SelfTestFailure("pipe.create-second", error);
  }
  CloseHandle(second);

  std::atomic<bool> client_ok{false};
  std::thread client([&]() {
    if (!WaitNamedPipeW(name.c_str(), 2'000)) {
      SelfTestFailure("client.wait", GetLastError());
      return;
    }
    HANDLE handle = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                                OPEN_EXISTING, 0, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
      SelfTestFailure("client.connect", GetLastError());
      return;
    }
    constexpr char kPing[] = "ping";
    DWORD written = 0;
    if (!WriteFile(handle, kPing, 4, &written, nullptr) || written != 4) {
      const DWORD error = GetLastError();
      CloseHandle(handle);
      SelfTestFailure("client.write", error);
      return;
    }
    char response[4]{};
    DWORD read = 0;
    if (ReadFile(handle, response, 4, &read, nullptr) && read == 4 &&
        std::memcmp(response, "pong", 4) == 0) {
      client_ok.store(true);
    } else {
      SelfTestFailure("client.read", GetLastError());
    }
    CloseHandle(handle);
  });

  bool server_ok = ConnectPipe(first);
  if (!server_ok) SelfTestFailure("server.connect", GetLastError());
  if (server_ok) {
    std::array<char, 4> request{};
    OVERLAPPED read_overlapped{};
    read_overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    DWORD read = 0;
    server_ok = read_overlapped.hEvent != nullptr;
    if (server_ok) {
      const BOOL completed = ReadFile(first, request.data(), 4, nullptr, &read_overlapped);
      const DWORD start_error = completed ? ERROR_SUCCESS : GetLastError();
      server_ok = FinishOverlapped(first, read_overlapped, completed, start_error, &read);
      server_ok = server_ok && read == 4 && std::memcmp(request.data(), "ping", 4) == 0;
      if (!server_ok) SelfTestFailure("server.read", GetLastError());
      CloseHandle(read_overlapped.hEvent);
    }
    if (server_ok) {
      OVERLAPPED write_overlapped{};
      write_overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
      DWORD written = 0;
      server_ok = write_overlapped.hEvent != nullptr;
      if (server_ok) {
        const BOOL completed = WriteFile(first, "pong", 4, nullptr, &write_overlapped);
        const DWORD start_error = completed ? ERROR_SUCCESS : GetLastError();
        server_ok = FinishOverlapped(first, write_overlapped, completed, start_error, &written);
        server_ok = server_ok && written == 4;
        if (!server_ok) SelfTestFailure("server.write", GetLastError());
        CloseHandle(write_overlapped.hEvent);
      }
    }
  }
  client.join();
  DisconnectNamedPipe(first);
  CloseHandle(first);
  if (!client_ok.load()) SelfTestFailure("client.exchange");
  return server_ok && client_ok.load();
}

bool ParseParentPid(int argc, wchar_t** argv, DWORD* parent_pid) {
  if (argc != 3 || std::wcscmp(argv[1], L"--parent-pid") != 0) return false;
  wchar_t* end = nullptr;
  const unsigned long value = std::wcstoul(argv[2], &end, 10);
  if (end == argv[2] || *end != L'\0' || value == 0 || value > MAXDWORD) return false;
  *parent_pid = static_cast<DWORD>(value);
  return true;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  g_shutdown_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (g_shutdown_event == nullptr) return 10;
  if (!DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &g_main_thread,
                       0, FALSE, DUPLICATE_SAME_ACCESS)) {
    CloseHandle(g_shutdown_event);
    return 11;
  }

  if (argc == 2 && std::wcscmp(argv[1], L"--self-test") == 0) {
    const bool ok = SelfTest();
    CloseHandle(g_main_thread);
    CloseHandle(g_shutdown_event);
    return ok ? 0 : 12;
  }

  DWORD parent_pid = 0;
  if (!ParseParentPid(argc, argv, &parent_pid)) {
    SendTextFrame(FrameType::kFatal, "Expected --parent-pid <pid>.");
    return 13;
  }
  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parent_pid);
  if (parent == nullptr) {
    SendTextFrame(FrameType::kFatal, "Could not bind pipe host lifetime to the parent process.");
    return 14;
  }
  CurrentUserSecurity security;
  if (!security.Initialize()) {
    SendTextFrame(FrameType::kFatal, "Could not build the current-user-only pipe DACL.");
    CloseHandle(parent);
    return 15;
  }
  const std::wstring pipe_name = RandomPipeName();
  if (pipe_name.empty()) {
    SendTextFrame(FrameType::kFatal, "Secure pipe-name generation failed.");
    CloseHandle(parent);
    return 16;
  }

  std::thread parent_watchdog([parent]() {
    HANDLE waits[] = {parent, g_shutdown_event};
    if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) == WAIT_OBJECT_0) SignalShutdown();
    CloseHandle(parent);
  });
  std::thread acceptor([&]() { AcceptClients(pipe_name, security); });

  InputFrameDecoder decoder;
  std::array<std::uint8_t, 64 * 1024> input{};
  while (WaitForSingleObject(g_shutdown_event, 0) != WAIT_OBJECT_0) {
    DWORD bytes_read = 0;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), input.data(), static_cast<DWORD>(input.size()),
                  &bytes_read, nullptr) || bytes_read == 0) {
      break;
    }
    if (!decoder.Push(input.data(), bytes_read)) break;
  }
  SetEvent(g_shutdown_event);
  acceptor.join();

  std::vector<std::shared_ptr<Connection>> connections;
  {
    std::scoped_lock lock(g_connections_mutex);
    for (const auto& entry : g_connections) connections.push_back(entry.second);
  }
  for (const auto& connection : connections) MarkClosing(connection);
  {
    std::scoped_lock lock(g_client_threads_mutex);
    for (auto& thread : g_client_threads) {
      if (thread.joinable()) thread.join();
    }
  }

  parent_watchdog.join();
  CloseHandle(g_main_thread);
  CloseHandle(g_shutdown_event);
  return 0;
}
