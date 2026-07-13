/** JSON SDP (scall mode) ↔ WebRTC SDP string — mirrors security.eufy.com portal. */

export interface ScallSdpJson {
  setup?: string;
  ice?: {
    ufrag?: string;
    pwd?: string;
    fingerprint_type?: string;
    fingerprint?: string;
  };
  candidate?: string[];
}

export function scallJsonToSdpOffer(json: ScallSdpJson): string {
  let sdp = "";
  sdp += "v=0\r\n";
  sdp += `o=- ${Math.floor(Date.now())} 1 IN IP4 127.0.0.1\r\n`;
  sdp += "s=Anker Webrtc Stream\r\n";
  sdp += "t=0 0\r\n";
  sdp += "a=group:BUNDLE 2\r\n";
  sdp += "a=msid-semantic: WMS\r\n";
  sdp += "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
  sdp += "c=IN IP4 127.0.0.1\r\n";
  sdp += "a=mid:2\r\n";
  sdp += "a=ice-options:trickle\r\n";

  if (json.ice?.ufrag) {
    sdp += `a=ice-ufrag:${json.ice.ufrag}\r\n`;
  }
  if (json.ice?.pwd) {
    sdp += `a=ice-pwd:${json.ice.pwd}\r\n`;
  }
  if (json.ice?.fingerprint) {
    const fp = json.ice.fingerprint.replace(/(.{2})(?=.)/g, "$1:");
    sdp += `a=fingerprint:${json.ice.fingerprint_type ?? "sha-256"} ${fp}\r\n`;
  }

  sdp += `a=setup:${json.setup ?? "actpass"}\r\n`;
  sdp += "a=sctp-port:5000\r\n";
  sdp += "a=max-message-size:262144\r\n";

  if (json.candidate?.length) {
    for (const c of json.candidate) {
      sdp += `a=candidate:${c}\r\n`;
    }
  }

  return sdp;
}

export function sdpAnswerToScallJson(sdp: string): ScallSdpJson {
  const json: ScallSdpJson = { ice: { ufrag: "", pwd: "", fingerprint: "" } };
  const lines = sdp.split(/\r\n|\r|\n/);

  const setupMatch = sdp.match(/a=setup:([^\r\n]+)/);
  if (setupMatch?.[1] && setupMatch[1] !== "actpass") {
    json.setup = setupMatch[1];
  }

  const ufragMatch = sdp.match(/a=ice-ufrag:([^\r\n]+)/);
  if (ufragMatch?.[1]) {
    json.ice!.ufrag = ufragMatch[1];
  }

  const pwdMatch = sdp.match(/a=ice-pwd:([^\r\n]+)/);
  if (pwdMatch?.[1]) {
    json.ice!.pwd = pwdMatch[1];
  }

  const fpMatch = sdp.match(/a=fingerprint:([^\s]+)\s+([^\r\n]+)/);
  if (fpMatch?.[2]) {
    json.ice!.fingerprint_type = fpMatch[1];
    json.ice!.fingerprint = fpMatch[2].replace(/:/g, "");
  }

  const candidates: string[] = [];
  for (const line of lines) {
    const m = line.match(/^a=candidate:(.+)/);
    if (m?.[1]) {
      candidates.push(m[1]);
    }
  }
  if (candidates.length > 0) {
    json.candidate = candidates;
  }

  return json;
}
