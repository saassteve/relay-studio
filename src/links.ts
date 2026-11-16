// Where Relay sends people who want to know what it is and who makes it.
export const REPO_URL = "https://github.com/saassteve/relay-studio";
// The ref tells brep a visit came from Relay. Relay itself tracks nothing, and
// links open without a referrer so a private share address is never passed on.
export const MAKER_URL = "https://brep.ai/?ref=relay";
// How to run a Relay server yourself, and the hosted one brep runs for you.
export const SELF_HOST_URL = `${REPO_URL}/blob/main/docs/SELF-HOSTING.md`;
export const CLOUD_URL = `${REPO_URL}/blob/main/docs/CLOUD.md`;
// In the Mac app a plain link already opens in the browser.
export const external = window.relayDesktop
  ? {}
  : { target: "_blank", rel: "noreferrer" };
