import Foundation
import Network

@MainActor
final class LoopbackListener {
    private var listener: NWListener?
    private var callback: CheckedContinuation<URL, Error>?
    private var expectedState = ""
    private var port: UInt16 = 0
    private var timeout: Task<Void, Never>?
    private var startup: CheckedContinuation<UInt16, Error>?
    private var connections: [UUID: NWConnection] = [:]

    func start() async throws -> UInt16 {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        return try await withCheckedThrowingContinuation { continuation in
            startup = continuation
            listener.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self, let continuation = self.startup else { return }
                    switch state {
                    case .ready:
                        self.startup = nil
                        guard let port = listener.port?.rawValue else { continuation.resume(throwing: ChatError.message("Could not open a sign-in callback port.")); return }
                        self.port = port; continuation.resume(returning: port)
                    case .failed(let error): self.startup = nil; continuation.resume(throwing: error)
                    case .cancelled: self.startup = nil; continuation.resume(throwing: CancellationError())
                    default: break
                    }
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                Task { @MainActor in self?.accept(connection) }
            }
            listener.start(queue: .main)
        }
    }

    func wait(state: String, openBrowser: () -> Void) async throws -> URL {
        expectedState = state
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                callback = continuation
                timeout = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(600)); self?.cancel(message: "Sign-in timed out. Please try again.") }
                    catch { }
                }
                openBrowser()
            }
        } onCancel: { Task { @MainActor [weak self] in self?.cancel() } }
    }

    func cancel(message: String = "Sign-in cancelled.") {
        callback?.resume(throwing: ChatError.message(message)); callback = nil
        stop()
    }

    private func stop() {
        timeout?.cancel(); timeout = nil
        listener?.cancel(); listener = nil
        for connection in connections.values { connection.cancel() }
        connections.removeAll()
    }

    private func accept(_ connection: NWConnection) {
        guard connections.count < 12 else { connection.cancel(); return }
        let id = UUID(); connections[id] = connection
        connection.start(queue: .main)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard let self else { return }
            self.connections.removeValue(forKey: id)?.cancel()
        }
        receive(connection, id: id, data: Data())
    }

    private func receive(_ connection: NWConnection, id: UUID, data: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] chunk, _, done, error in
            Task { @MainActor in
                guard let self else { connection.cancel(); return }
                let buffer = data + (chunk ?? Data())
                if buffer.count > 16384 { self.reply(connection, id: id, accepted: false); return }
                if let request = String(data: buffer, encoding: .utf8), request.contains("\r\n\r\n") {
                    let url = Self.callbackURL(request: request, port: self.port, state: self.expectedState)
                    self.reply(connection, id: id, accepted: url != nil) {
                        if let url, let callback = self.callback {
                            self.callback = nil; callback.resume(returning: url); self.stop()
                        }
                    }
                } else if done || error != nil { self.connections.removeValue(forKey: id); connection.cancel() }
                else { self.receive(connection, id: id, data: buffer) }
            }
        }
    }

    static func callbackURL(request: String, port: UInt16, state: String) -> URL? {
        let lines = request.components(separatedBy: "\r\n")
        guard !state.isEmpty, let first = lines.first else { return nil }
        let parts = first.split(separator: " ")
        guard parts.count == 3, parts[0] == "GET", parts[2] == "HTTP/1.1", parts[1].hasPrefix("/auth/callback?"),
              lines.filter({ $0.lowercased().hasPrefix("host:") }).count == 1,
              lines.contains(where: { $0.lowercased() == "host: 127.0.0.1:\(port)" }),
              let url = URL(string: "http://127.0.0.1:\(port)\(parts[1])"),
              let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              query.filter({ $0.name == "state" }).count == 1,
              query.first(where: { $0.name == "state" })?.value == state else { return nil }
        return url
    }

    private func reply(_ connection: NWConnection, id: UUID, accepted: Bool, completion: @escaping @MainActor @Sendable () -> Void = {}) {
        let body = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Safari Chat</title><h1>\(accepted ? "Return to Safari Chat" : "Sign-in request not recognized")</h1><p>\(accepted ? "The app is verifying your sign-in. You can close this tab." : "Start sign-in from the Safari Chat app.")</p>"
        let response = "HTTP/1.1 \(accepted ? "200 OK" : "400 Bad Request")\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n\(body)"
        connection.send(content: Data(response.utf8), completion: .contentProcessed { [weak self] _ in
            Task { @MainActor in
                self?.connections.removeValue(forKey: id); connection.cancel(); completion()
            }
        })
    }
}
