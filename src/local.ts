// True when Relay is open on this computer's own address, which no one else can reach.
export const isLocal = ["127.0.0.1", "localhost", "[::1]"].includes(
  location.hostname,
);
