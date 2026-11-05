import Foundation

actor AuthService {
    static let shared = AuthService()
    private var refreshes: [String: Task<Account, Error>] = [:]

    func eraseLocalData() throws {
        for task in refreshes.values { task.cancel() }
        refreshes.removeAll()
        try CredentialStore.eraseAll()
        try LocalDataCleaner.eraseCurrentProcess()
    }

    func credential() async throws -> Account {
        let vault = try CredentialStore.read()
        guard let account = vault.active, account.canInfer else { throw ChatError.message("Enable ChatGPT plan usage or connect an API key in the companion app.") }
        if account.isAPIKey || account.expiresAt > Date().addingTimeInterval(60) { return account }
        if let task = refreshes[account.id] { return try await task.value }
        if let earliest = account.earliestRefreshAt, earliest > Date() {
            if account.expiresAt > Date() { return account }
            throw ChatError.message("Your session cannot be refreshed yet. Try signing in again.")
        }
        guard let token = account.refreshToken else { throw ChatError.message("Your session expired. Sign in again in the companion app.") }
        let task = Task<Account, Error> {
            let response = try await OAuthClient.exchange(["grant_type": "refresh_token", "client_id": account.id,
                "refresh_token": token, "resource": Configuration.resource])
            guard let replacement = response.refresh_token, !replacement.isEmpty else { throw ChatError.message("OpenAI did not return a replacement refresh token. Please sign in again.") }
            var updated = account
            updated.accessToken = response.access_token
            updated.refreshToken = replacement
            updated.expiresAt = Date().addingTimeInterval(response.expires_in)
            updated.earliestRefreshAt = response.earliest_refresh_at.map { Date(timeIntervalSince1970: $0) }
            if let scope = response.scope { updated.scopes = scope.split(separator: " ").map(String.init) }
            // Retain the original validated ID token as a hint, not an authentication credential.
            try CredentialStore.update { vault in
                guard vault.activeID == account.id,
                      let index = vault.accounts.firstIndex(where: { $0.id == account.id }),
                      vault.accounts[index].refreshToken == token else { throw ChatError.message("Your account changed while refreshing. Please retry.") }
                vault.accounts[index] = updated
            }
            guard updated.canInfer else { throw ChatError.message("ChatGPT plan usage is no longer authorized. Reconnect your account.") }
            return updated
        }
        refreshes[account.id] = task
        defer { refreshes[account.id] = nil }
        return try await task.value
    }
}
