const toggle = document.getElementById("toggle");
let running = false;

function render() {
  toggle.textContent = running ? "■ Stoppen" : "▶ Starten";
}

lssLoadSettings().then((s) => {
  running = s.running;
  render();
});
toggle.addEventListener("click", () => {
  running = !running;
  chrome.storage.sync.set({ running });
  render();
});
document.getElementById("options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
