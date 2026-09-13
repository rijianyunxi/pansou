import { setHostResolver } from "../server/core/security/dnsGuard";

// Unit tests must stay hermetic (no public network, no real DNS lookups).
// Tests that exercise DNS behavior inject their own resolver via
// setHostResolver() and reset it in afterEach.
setHostResolver(null);
