# Android Webcam System
Turn your Android phone into a high-quality webcam - fully local, Opensource.

_**Open-source (GPL-3.0)**_

>## 🎉 Milestone Achieved
>AWA is now available on Google Play!

## Latest Releases
<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <h3>Android Webcam App (AWA)</h3>
      <p>Android · Mobile</p>
      <a href="https://github.com/soubhagyajit/Mobile-Webcam/releases">
        <img
          src="https://img.shields.io/github/v/release/soubhagyajit/Mobile-Webcam?label=Latest%20Release&style=for-the-badge"
          alt="AWA Latest Release"
        >
      </a>
      <br><br>
      <a href="https://play.google.com/store/apps/details?id=com.soubhagyajit.awa">
        <img
          src="https://play.google.com/intl/en_us/badges/images/generic/en_badge_web_generic.png"
          alt="Get it on Google Play"
          width="140"
        >
      </a>
    </td>
    <td width="50%" align="center" valign="top">
      <h3>Android Webcam Client<br>(AWC)</h3>
      <p>Desktop · Windows</p>
      <a href="https://github.com/soubhagyajit/Mobile-Webcam/releases">
        <img
          src="https://img.shields.io/github/v/release/soubhagyajit/Mobile-Webcam?label=Latest%20Release&style=for-the-badge"
          alt="AWC Latest Release"
        >
      </a>
      <br><br>
      <a href="https://github.com/soubhagyajit/Mobile-Webcam/releases">
        Download Client
      </a>
    </td>
  </tr>
</table>


> [!NOTE]
> ## Sponsorship Needed
>
> Android Webcam Project currently supports Android and Windows.
> I'd like to expand it to iOS and macOS, but Apple development
> requires access to macOS hardware.
>
> If you'd like to support the project, sponsorships will help
> fund the hardware needed to develop and test Apple-platform
> versions.

## What's Included

This is a **complete professional solution** with:

- 📱 **Kotlin Mobile App** (Android for now)
- 💻 **Tauri Desktop Client** (Windows/Mac/Linux)
- 🔌 **USB Connection Support** (low latency, more stable)
- 📡 **WiFi Connection Support** (wireless freedom)

## Components

### AWC [Desktop Client]
Tauri-based app that connects to your phone and outputs virtual webcam.

### AWA [Android App]
Kotlin-based mobile app that acts as the streaming server.
## Features

### Mobile App
- HD/FHD/4K resolution support (480p, 720p, 1080p, 4K)
- Front/back camera switching
- Manual/Auto Focus
- Zoom/Lens switch
- USB and WiFi connection modes
- Real-time connection status
- Low battery usage
#### *(Planned)*
- Adjustable FPS (15, 30, 60 fps) 

### Desktop Client
- Virtual webcam device (works with Zoom, Teams, Meet, OBS, etc.)
- Clean, modern UI
- Connection statistics

### Connection Options
- **USB Mode**: Lower latency, more stable, no WiFi needed
- **WiFi Mode**: Wireless freedom, works anywhere

## Prerequisites

### Required
- **PC**: Windows 10+, (*Planned for* macOS and Linux)
- **Phone**: Android 8.0+

### For Development
- **Android Studio** (for Android builds)
- **VS Code** (recommended editor)
- Or your favourite software for developement


## Using as Virtual Webcam

The desktop client creates a virtual webcam that works with:

- ✅ Zoom
- ✅ Microsoft Teams
- ✅ Google Meet
- ✅ Discord
- ✅ OBS Studio
- ✅ Skype
- ✅ Any app that uses webcams!

### Windows Setup
The virtual webcam should appear automatically in your video apps.

<!-- ### Mac Setup
Grant camera permissions in System Preferences → Security & Privacy

### Linux Setup
May require `v4l2loopback` kernel module:
```bash
sudo apt-get install v4l2loopback-dkms
``` -->

## Configuration

### Change Resolution
Edit in mobile app settings or in code:
- 480p (640x480) - Low bandwidth
- 720p (1280x720) - **Recommended for older phones**
- 1080p (1920x1080) - High quality
- 4K (3840x2160) - Maximum quality


## Building for Production

### Desktop Apps
```bash
cd desktop-client

# Windows
npm run build:win

```

## Troubleshooting

### Connection Issues

**"Can't connect -"**
- Check firewall (allow port 8080 and 8554 - default ports)
- Verify same WiFi network (for WiFi mode)
- Check USB debugging (for USB mode)


### Video Quality Issues

- Lower resolution to 720p
- Use USB instead of WiFi
- Close other apps using camera
- Use 5GHz WiFi if available

## Advantages Over Other APPs

| Feature | AWA | Other APPs  |
|---------|--------------|----------|
| Price | **Free** | Pay for HD and high resolutions |
| Resolution | Up to 4K | 720p (free), 1080p (paid) |
| Open Source (Customize as you want) | ✅ Yes | ❌ No |
| USB Support | ✅ Yes | ✅ Yes |
| WiFi Support | ✅ Yes | ✅ Yes |
| Customizable | ✅ Full control | ❌ No |
| Privacy | ✅ Self-hosted | ⚠️ |
| No Ads | ✅ Yes | ❌ Has ads |

## Contributing

This is an open-source project! Contributions welcome:

- 🐛 Report bugs
- 💡 Suggest features
- 🔧 Submit pull requests
- 📖 Improve documentation
- ⭐ Star the repository

## License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**.

© 2026 Soubhagyajit Borah

### What this means:

* ✅ You can use, modify, and distribute this software
* ✅ You can use it commercially
* ⚠️ You must disclose source code if you distribute it
* ⚠️ Any derivative work must also be licensed under GPL-3.0

See the [LICENSE](LICENSE) file for full details.


## Acknowledgments

- Virtual camera powered by [Softcam](https://github.com/tshino/softcam) © tshino (MIT License)
- Built with Kotlin, Tauri.
- Inspired by DroidCam and similar tools.
- Made with ❤️ for the open-source community.

## Roadmap

- [ ] Able to stream while the phone screen is off (only dim option available now)
- [ ] Run as Background service
- [ ] More layout optimization
- [ ] Audio streaming support
- [ ] Recording functionality
- [x] ~~Mobile app on app stores~~ (Now available on Google Play: https://play.google.com/store/apps/details?id=com.soubhagyajit.awa)

## Support

Having issues? Found a bug?

1. Create a new issue with details
2. Join our community discussions

> [!TIP]
> **Enjoying Android Webcam Project?** ⭐
>
> If this project helped you, please consider leaving a **GitHub Star** and sharing your feedback. Your support helps the project grow and motivates future development!

---
**Happy streaming! Made with ❤️ and ☕ by developers, for developers.**

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/R5O327R68W)
