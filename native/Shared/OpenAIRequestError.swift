import Foundation

struct OpenAIRequestError: LocalizedError {
    let status: Int?
    let errorDescription: String?

    init(_ payload: Any?, status: Int? = nil, requestID: String? = nil, redacting secrets: [String] = []) {
        self.status = status
        func field(_ value: Any?, _ limit: Int = 700) -> String? {
            let raw: String
            if let string = value as? String { raw = string }
            else if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() { raw = number.stringValue }
            else { return nil }
            let safe = secrets.reduce(raw) { text, secret in
                secret.isEmpty ? text : text.replacingOccurrences(of: secret, with: "[redacted]")
            }.trimmingCharacters(in: .whitespacesAndNewlines)
            return safe.isEmpty ? nil : String(safe.prefix(limit))
        }
        let root = payload as? [String: Any] ?? [:]
        let value = root["error"] ?? root["detail"] ?? payload
        let detail = value as? [String: Any] ?? [:]
        let scalar = field(value)
        var explicitCode = field(detail["code"], 96) ?? field(root["code"], 96) ?? field(detail["error_code"], 96)
        if explicitCode == nil, let scalar, value is NSNumber || (root["error"] != nil && scalar.range(of: #"^[\w.-]{1,96}$"#, options: .regularExpression) != nil) {
            explicitCode = scalar
        }
        let type = field(detail["type"], 96)
        let typeCode = type == "error" ? nil : type
        let code = (explicitCode.flatMap(Int.init) != nil ? typeCode : nil) ?? explicitCode ?? typeCode
        let validation = (value as? [[String: Any]])?.prefix(4).compactMap { field($0["msg"] ?? $0["message"], 160) }.joined(separator: " ")
        let message = field(detail["message"]) ?? field(root["message"]) ?? field(root["error_description"])
            ?? field(root["detail"]) ?? field(validation) ?? (scalar == explicitCode ? nil : scalar)
        let http = status.map { "HTTP \($0)" }
        let summary = message ?? code.map { "OpenAI error \($0)." } ?? http ?? "OpenAI did not provide an error description."
        let parameter = field(detail["param"], 96).map { "parameter \($0)" }
        let reference = (field(requestID, 128) ?? field(root["request_id"], 128)).map { "Request \($0)" }
        let diagnostics = [message == nil ? nil : code, explicitCode == code ? nil : explicitCode,
                           http == summary ? nil : http, parameter, reference].compactMap { $0 }
        let suffix = diagnostics.isEmpty ? "" : " (\(diagnostics.joined(separator: ", ")))"
        errorDescription = String(summary.prefix(1000 - suffix.count)) + suffix
    }

    static func requireOK(_ data: Data, _ response: URLResponse, redacting secrets: [String] = []) throws {
        let http = response as? HTTPURLResponse
        var payload: Any?
        if data.count <= 256_000 {
            payload = try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)
        }
        let error = (payload as? [String: Any])?["error"]
        if http?.statusCode == 200 && (error == nil || error is NSNull) { return }
        if payload == nil, response.mimeType == "text/plain",
           let text = String(data: data.prefix(8192), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !text.hasPrefix("<") {
            payload = text
        }
        throw Self(payload, status: http?.statusCode, requestID: http?.value(forHTTPHeaderField: "x-request-id"), redacting: secrets)
    }
}
