const go = document.getElementById("go") as HTMLButtonElement;
const out = document.getElementById("out") as HTMLTextAreaElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;

go.addEventListener("click", async () => {
  go.disabled = true;
  statusEl.textContent = " loading…";
  out.value = "";
  const started = Date.now();
  try {
    const response = await fetch("/api/llm");
    const json = await response.json();
    out.value = JSON.stringify(json, null, 2);
    statusEl.textContent = ` done in ${Date.now() - started}ms`;
  } catch (error) {
    out.value = String(error);
    statusEl.textContent = " error";
  } finally {
    go.disabled = false;
  }
});
