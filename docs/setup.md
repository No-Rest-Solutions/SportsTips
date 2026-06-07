# 🛠️ Installation & Setup

This guide covers how to run the **SportsTips Tipping Bot**, whether you are using the pre-compiled portable application or running from source.

## 🚀 Quick Start (Windows)
1. Navigate to the `dist/tipping-bot-workspace/` directory.
2. Double-click the executable to launch the Dashboard UI.
3. Click **"Turn On"** to start the background automation.

## 💻 Developer Setup
- **Node.js**: Version 22.0.0 or higher is required.
- **npm**: Installed automatically with Node.js.
- **Windows OS**: The launcher and binary signing are optimized for Windows environments.

1. **Install Dependencies**:
   Open your terminal in the root directory and run:
```bash
npm install
```

## 3. Configuration
The bot requires specific configuration files that are excluded from source control for security.

1. Navigate to the `automation/discord-webhooks/` directory.
2. Rename `config.example.json` to `config.json`.
3. Open `config.json` and paste your **Discord Webhook URLs** into the relevant fields.
4. Rename `.env.example` to `.env`.
5. Add your `OPENAI_API_KEY` to the `.env` file if you intend to use the AI analysis engine.

## 4. Launching the App
There are two ways to start the application:

### Standard Launch
Run the following command from the root directory:
```bash
npx electron .
```

### Background Launch (Windows)
Double-click `tipping bot.vbs` in the root directory to launch the dashboard silently without a persistent terminal window.

## 5. Starting Automation
Once the Dashboard UI opens, click **"Turn On"**. This spawns the background daemon process which begins the market scraping and analysis schedule.