# eufy-security-ws-customrepo

Home Assistant add-on that builds **eufy-security-ws 3.0.1** with:

- Custom **eufy-security-client** from GitHub (`genomez/eufy-security-client#T9000-testing`)
- Automatic **eufy_mega v6** login (mega-login patch)
- **Node 24** base image

## T9000 (HomeBase Professional S1)

**Full setup guide:** [T9000-SETUP.md](../T9000-SETUP.md)

Quick start:

1. Add repository `https://github.com/genomez/hassio-eufy-security-ws`
2. Install this add-on (**eufy-security-ws-customrepo**)
3. Configure Eufy credentials + **`stations`** IP hints for your T9000 (recommended for P2P control)
4. Install [fuatakgun/eufy_security](https://github.com/fuatakgun/eufy_security) via HACS and connect to `host:3000`
