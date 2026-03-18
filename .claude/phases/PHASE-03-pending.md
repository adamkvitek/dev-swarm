# Phase 03 — Certificate Samples & Extended Language Runners
Status: PENDING

## Goal
Expand the verification pipeline with security-focused certificate samples and add C/VB.NET runners for broader language coverage.

## Tasks
- [ ] Add certificate/TLS sample programs (generate self-signed cert, parse X.509, validate chain)
- [ ] Implement C runner in verify-all.mjs (gcc compile + execute)
- [ ] Implement VB.NET runner in verify-all.mjs (dotnet run with .vb files or vbc compiler)
- [ ] Add certificate samples in Python (ssl/cryptography lib)
- [ ] Add certificate samples in Java (keytool/java.security)
- [ ] Add certificate samples in C# (System.Security.Cryptography.X509Certificates)
- [ ] Add certificate samples in C (OpenSSL)
- [ ] Cross-language validation for certificate output (subject, issuer, expiry)
- [ ] Update LANGUAGE_COMMANDS and SupportedLanguage types for new languages
- [ ] Add runtime detection for gcc and vbc/dotnet

## Acceptance Criteria
- Certificate samples run in at least 3 languages with consistent output
- C runner compiles and executes .c files via gcc
- VB.NET runner executes .vb files
- All new samples pass cross-language validation
- Runtime detection gracefully skips missing compilers (gcc, vbc)

## Decisions To Make
- Which certificate operations to test (generation, parsing, validation, or all)?
- Use OpenSSL CLI vs C API for the C samples?
- VB.NET via dotnet run (requires .NET 10+ bare file support for .vb) or vbc compiler?
