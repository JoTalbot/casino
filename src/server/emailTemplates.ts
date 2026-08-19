import { readFile } from "node:fs/promises";

export async function renderTemplate(name: string, vars: Record<string, string>): Promise<string> {
  try {
    const path = `templates/email/${name}.html`;
    let html = await readFile(path, "utf8");
    for (const [k, v] of Object.entries(vars)) {
      html = html.replaceAll(`{{${k}}}`, v);
    }
    return html;
  } catch {
    return `<p>${Object.entries(vars).map(([k,v])=>`${k}: ${v}`).join("<br>")}</p>`;
  }
}
