// Where Relay sends people who want to know what it is and who makes it.
export const REPO_URL = "https://github.com/saassteve/relay-studio";
// The ref tells brep a visit came from Relay. Relay itself tracks nothing, and
// links open without a referrer so a private share address is never passed on.
export const MAKER_URL = "https://brep.ai/?ref=relay";
// In the Mac app a plain link already opens in the browser.
export const external = window.relayDesktop
  ? {}
  : { target: "_blank", rel: "noreferrer" };
