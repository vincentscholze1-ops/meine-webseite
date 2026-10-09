lssLoadSettings().then((s) => {
  for (const id of ["enabled", "autoSelect", "alarmAndNext"]) {
    const el = document.getElementById(id);
    el.checked = s[id];
    el.addEventListener("change", () => chrome.storage.sync.set({ [id]: el.checked }));
  }
});
document.getElementById("options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
