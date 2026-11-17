import Foundation
import Network

/// A bounded, authenticated loopback inbox. No page data or credentials are written to disk.
@MainActor
final class DesktopHTTP {
    private var listener: NWListener?
    private var startup: CheckedContinuation<UInt16, Error>?
    private var connections: [UUID: NWConnection] = [:]
    private var token = ""
    private var port: UInt16 = 0
    var receive: ((Data) -> Void)?

    func start(token: String) async throws -> UInt16 {
        self.token = token
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters); self.listener = listener
        return try await withCheckedThrowingContinuation { continuation in
            startup = continuation
            listener.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self, let pending = self.startup else { return }
                    switch state {
                    case .ready:
                        self.startup = nil
                        guard let port = listener.port?.rawValue else { pending.resume(throwing: ChatError.message("Could not open the desktop inbox.")); return }
                        self.port = port; pending.resume(returning: port)
                    case .failed(let error): self.startup = nil; pending.resume(throwing: error)
                    case .cancelled: self.startup = nil; pending.resume(throwing: CancellationError())
                    default: break
                    }
                }
            }
            listener.newConnectionHandler = { [weak self] connection in Task { @MainActor in self?.accept(connection) } }
            listener.start(queue: .main)
        }
    }

    func stop() {
        listener?.cancel(); listener = nil
        for connection in connections.values { connection.cancel() }
        connections.removeAll(); token = ""
    }

    /// nil means incomplete. Invalid or ambiguous framing is rejected before parsing JSON.
    static func body(_ data: Data, port: UInt16, token: String) throws -> Data? {
        guard data.count <= 266384 else { throw ChatError.message("Desktop message is too large.") }
        guard let split = data.range(of: Data("\r\n\r\n".utf8)) else {
            if data.count > 16384 { throw ChatError.message("Desktop headers are too large.") }
            return nil
        }
        guard split.lowerBound <= 16384, let header = String(data: data[..<split.lowerBound], encoding: .utf8) else { throw ChatError.message("Invalid desktop headers.") }
        let lines = header.components(separatedBy: "\r\n")
        guard lines.first == "POST /reply HTTP/1.1" else { throw ChatError.message("Invalid desktop route.") }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { throw ChatError.message("Invalid desktop header.") }
            let name = line[..<colon].lowercased()
            guard headers[name] == nil else { throw ChatError.message("Duplicate desktop header.") }
            headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        guard !token.isEmpty, headers["host"] == "127.0.0.1:\(port)", headers["authorization"] == "Bearer \(token)",
              headers["origin"] == nil, headers["transfer-encoding"] == nil,
              let rawLength = headers["content-length"], rawLength.allSatisfy({ $0.isASCII && $0.isNumber }),
              let length = Int(rawLength), length > 0, length <= 250000 else { throw ChatError.message("Unauthorized or invalid desktop message.") }
        let body = data[split.upperBound...]
        guard body.count <= length else { throw ChatError.message("Unexpected bytes after desktop message.") }
        return body.count == length ? Data(body) : nil
    }

    private func accept(_ connection: NWConnection) {
        guard connections.count < 8 else { connection.cancel(); return }
        let id = UUID(); connections[id] = connection
        connection.start(queue: .main)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            self?.connections.removeValue(forKey: id)?.cancel()
        }
        read(connection, id: id, data: Data())
    }

    private func read(_ connection: NWConnection, id: UUID, data: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] chunk, _, done, error in
            Task { @MainActor in
                guard let self else { connection.cancel(); return }
                do {
                    let buffer = data + (chunk ?? Data())
                    if let body = try Self.body(buffer, port: self.port, token: self.token) {
                        self.receive?(body)
                        self.respond(connection, id: id, accepted: true)
                    } else if done || error != nil { self.respond(connection, id: id, accepted: false) }
                    else { self.read(connection, id: id, data: buffer) }
                } catch { self.respond(connection, id: id, accepted: false) }
            }
        }
    }

    private func respond(_ connection: NWConnection, id: UUID, accepted: Bool) {
        let text = "HTTP/1.1 \(accepted ? "200 OK" : "400 Bad Request")\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(text.utf8), completion: .contentProcessed { [weak self] _ in
            Task { @MainActor in self?.connections.removeValue(forKey: id); connection.cancel() }
        })
    }
}
