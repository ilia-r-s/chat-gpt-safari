import Foundation
import Security
import CryptoKit

struct IdentityClaims: Equatable { let subject: String; let email: String; let name: String }

enum IDToken {
    static func validate(_ token: String, audience: String, nonce: String) async throws -> IdentityClaims {
        var request = URLRequest(url: Configuration.jwks)
        request.timeoutInterval = 20
        let (data, response) = try await SecureHTTP.session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200, data.count < 200000,
              let jwks = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let keys = jwks["keys"] as? [[String: Any]] else { throw ChatError.message("Could not retrieve OpenAI's signing keys.") }
        return try verify(token, keys: keys, audience: audience, nonce: nonce)
    }

    static func verify(_ token: String, keys: [[String: Any]], audience: String, nonce: String, now: Date = Date()) throws -> IdentityClaims {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, token.count < 100000,
              let headerData = Data(base64URL: parts[0]), let body = Data(base64URL: parts[1]), let signature = Data(base64URL: parts[2]),
              let header = try JSONSerialization.jsonObject(with: headerData) as? [String: Any],
              let kid = header["kid"] as? String, let algorithm = header["alg"] as? String,
              ["RS256", "ES256"].contains(algorithm), header["crit"] == nil,
              let key = keys.first(where: { ($0["kid"] as? String) == kid && (($0["use"] as? String) ?? "sig") == "sig" && (($0["alg"] as? String) ?? algorithm) == algorithm }) else {
            throw ChatError.message("Invalid identity-token signature metadata.")
        }
        let signed = Data("\(parts[0]).\(parts[1])".utf8)
        let valid: Bool
        if algorithm == "RS256" {
            guard key["kty"] as? String == "RSA", let n = key["n"] as? String, let e = key["e"] as? String,
                  let modulus = Data(base64URL: n), let exponent = Data(base64URL: e), modulus.count >= 256 else { throw ChatError.message("Invalid RSA signing key.") }
            let der = sequence(integer(modulus) + integer(exponent))
            var error: Unmanaged<CFError>?
            guard let publicKey = SecKeyCreateWithData(der as CFData, [kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeyClass: kSecAttrKeyClassPublic] as CFDictionary, &error) else { throw ChatError.message("Could not decode the identity signing key.") }
            valid = SecKeyVerifySignature(publicKey, .rsaSignatureMessagePKCS1v15SHA256, signed as CFData, signature as CFData, &error)
        } else {
            guard key["kty"] as? String == "EC", key["crv"] as? String == "P-256",
                  let x = key["x"] as? String, let y = key["y"] as? String,
                  let xData = Data(base64URL: x), let yData = Data(base64URL: y), xData.count == 32, yData.count == 32 else { throw ChatError.message("Invalid elliptic-curve signing key.") }
            let publicKey = try P256.Signing.PublicKey(x963Representation: Data([0x04]) + xData + yData)
            valid = try publicKey.isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: signature), for: signed)
        }
        guard valid else { throw ChatError.message("The identity-token signature could not be verified.") }
        return try validateClaims(body, audience: audience, nonce: nonce, now: now)
    }

    static func validateClaims(_ body: Data, audience: String, nonce: String, now: Date) throws -> IdentityClaims {
        guard let claims = try JSONSerialization.jsonObject(with: body) as? [String: Any],
              claims["iss"] as? String == Configuration.issuer,
              let expiration = claims["exp"] as? Double, expiration > now.timeIntervalSince1970,
              claims["nonce"] as? String == nonce,
              let subject = claims["sub"] as? String, !subject.isEmpty else { throw ChatError.message("The identity token is expired or does not match this sign-in.") }
        let audiences = (claims["aud"] as? [String]) ?? (claims["aud"] as? String).map { [$0] } ?? []
        guard audiences.contains(audience), audiences.count == 1 || claims["azp"] as? String == audience else { throw ChatError.message("The identity token was issued to another app.") }
        if let authorizedParty = claims["azp"] as? String, authorizedParty != audience { throw ChatError.message("The identity token has an unexpected authorized party.") }
        if let notBefore = claims["nbf"] as? Double, notBefore > now.timeIntervalSince1970 + 30 { throw ChatError.message("The identity token is not valid yet.") }
        if let issuedAt = claims["iat"] as? Double, issuedAt > now.timeIntervalSince1970 + 30 { throw ChatError.message("The identity token was issued in the future.") }
        return IdentityClaims(subject: subject, email: claims["email"] as? String ?? "", name: claims["name"] as? String ?? "ChatGPT account")
    }

    private static func length(_ value: Int) -> Data {
        if value < 128 { return Data([UInt8(value)]) }
        var remaining = value; var bytes: [UInt8] = []
        while remaining > 0 { bytes.insert(UInt8(remaining & 255), at: 0); remaining >>= 8 }
        return Data([0x80 | UInt8(bytes.count)] + bytes)
    }
    private static func integer(_ data: Data) -> Data {
        let bytes = data.first.map { $0 >= 128 } == true ? Data([0]) + data : data
        return Data([0x02]) + length(bytes.count) + bytes
    }
    private static func sequence(_ data: Data) -> Data { Data([0x30]) + length(data.count) + data }
}
