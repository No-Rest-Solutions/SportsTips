import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sportsTipsDesktop', {
  getStatus: () => ipcRenderer.invoke('desktop:get-status'),
  startDaemon: () => ipcRenderer.invoke('desktop:start-daemon'),
  stopDaemon: () => ipcRenderer.invoke('desktop:stop-daemon'),
  reviewResults: () => ipcRenderer.invoke('desktop:review-results'),
  forceDailyCheck: () => ipcRenderer.invoke('desktop:force-daily-check'),
  forcePostPicks: () => ipcRenderer.invoke('desktop:force-post-picks'),
  runReferralsNow: () => ipcRenderer.invoke('desktop:run-referrals-now'),
  verifyReferral: (payload) => ipcRenderer.invoke('desktop:verify-referral', payload),
  saveSettings: (payload) => ipcRenderer.invoke('desktop:save-settings', payload),
  settlePickManually: (payload) => ipcRenderer.invoke('desktop:settle-pick-manually', payload),
  reanalyzeSlip: (payload) => ipcRenderer.invoke('desktop:reanalyze-slip', payload),
  applyReanalyzedPick: (payload) => ipcRenderer.invoke('desktop:apply-reanalyzed-pick', payload),
  analyzeAllSlips: () => ipcRenderer.invoke('desktop:analyze-all-slips'),
  fullScan: () => ipcRenderer.invoke('desktop:full-scan'),
  openConfig: () => ipcRenderer.invoke('desktop:open-config')
});
