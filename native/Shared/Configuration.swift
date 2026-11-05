import Foundation

enum Configuration {
    static let issuer = "https://auth.openai.com"
    static let authorize = URL(string: issuer + "/api/accounts/authorize")!
    static let token = URL(string: issuer + "/api/accounts/oauth/token")!
    static let jwks = URL(string: issuer + "/.well-known/jwks.json")!
    static let resource = "https://api.openai.com/v1"
    static let scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
    static var extensionID: String { Bundle.main.object(forInfoDictionaryKey: "SafariExtensionIdentifier") as? String ?? "org.safarichat.app.Extension" }
    static let service = "org.safarichat.credentials"
}

enum ChatError: LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case .message(let text): return text } }
}

struct Account: Codable, Identifiable, Equatable {
    var id: String
    var subject: String
    var email: String
    var name: String
    var accessToken: String?
    var refreshToken: String?
    var idToken: String?
    var expiresAt: Date
    var earliestRefreshAt: Date?
    var scopes: [String]
    var isAPIKey: Bool = false

    var canInfer: Bool { accessToken != nil && (isAPIKey || scopes.contains("chatgpt.tokens.use.direct")) }
    var label: String { isAPIKey ? "OpenAI API key" : "\(email.isEmpty ? name : email) · \(id.suffix(6))" }
}

struct Vault: Codable {
    var hostID = "urn:uuid:\(UUID().uuidString.lowercased())"
    var activeID: String?
    var accounts: [Account] = []
    var active: Account? { accounts.first { $0.id == activeID } }
}

extension Data {
    var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    init?(base64URL: String) {
        let value = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        self.init(base64Encoded: value + String(repeating: "=", count: (4 - value.count % 4) % 4))
    }
}
