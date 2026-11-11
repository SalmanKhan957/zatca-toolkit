/**
 * A throwaway secp256k1 key and self-signed certificate generated with OpenSSL for
 * unit tests only. It is NOT a ZATCA-issued certificate and has no value outside tests.
 *
 *   openssl ecparam -name secp256k1 -genkey -noout -out key.pem
 *   openssl req -new -x509 -key key.pem -sha256 -days 3650 \
 *     -subj "/C=SA/O=Test Org/OU=Riyadh Branch/CN=TST-886431145-399999999900003"
 */
export const TEST_PRIVATE_KEY_PEM = `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIMf3S32h0C3PnrC7DZzbnqTQotKkPJMFZgd6vIrwFT9ioAcGBSuBBAAK
oUQDQgAEaEYvG9CXp2gzPC3d1nJA1u5s03a0n9Ht1uAYv95hopzxdMxxIs4tevr+
L1ehXHJ+JO80GvObzpEE1J0QuQs2WQ==
-----END EC PRIVATE KEY-----`;

export const TEST_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIICEjCCAbigAwIBAgIUCOwXqyirj/xAf7tAjFbLxNuA8AUwCgYIKoZIzj0EAwIw
YDELMAkGA1UEBhMCU0ExETAPBgNVBAoMCFRlc3QgT3JnMRYwFAYDVQQLDA1SaXlh
ZGggQnJhbmNoMSYwJAYDVQQDDB1UU1QtODg2NDMxMTQ1LTM5OTk5OTk5OTkwMDAw
MzAeFw0yNjExMTAwMDA3MjdaFw0zNjExMDcwMDA3MjdaMGAxCzAJBgNVBAYTAlNB
MREwDwYDVQQKDAhUZXN0IE9yZzEWMBQGA1UECwwNUml5YWRoIEJyYW5jaDEmMCQG
A1UEAwwdVFNULTg4NjQzMTE0NS0zOTk5OTk5OTk5MDAwMDMwVjAQBgcqhkjOPQIB
BgUrgQQACgNCAARoRi8b0JenaDM8Ld3WckDW7mzTdrSf0e3W4Bi/3mGinPF0zHEi
zi16+v4vV6Fccn4k7zQa85vOkQTUnRC5CzZZo1MwUTAdBgNVHQ4EFgQUELjshUaN
Hx0RvQCgxJj1YZEplSswHwYDVR0jBBgwFoAUELjshUaNHx0RvQCgxJj1YZEplSsw
DwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiAHAuFqxrDmJifczvYI
bwWcJPMPckpJdoduP4WOR3l18wIhAJaRRybgb0gAFwaVHi6UwWRamvjUjbLw4rHW
0TraInhc
-----END CERTIFICATE-----`;

/** Values reported by `openssl x509` for the certificate above. */
export const TEST_CERTIFICATE_FACTS = {
  serialHex: '08EC17AB28AB8FFC407FBB408C56CBC4DB80F005',
  issuer: 'CN=TST-886431145-399999999900003, OU=Riyadh Branch, O=Test Org, C=SA',
  spkiSha256Hex: 'f295618a092eb5cb80f86d87fe2ab9418af4cf048ea890b02ca4f8d5b282dd7e',
  derSha256Hex: 'b638b63a1cf06da30299bbda804dafb98bf2548e8e7886e96e6a5c71bc65eb17',
};
