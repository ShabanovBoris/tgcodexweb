import { chromium, type BrowserContext, type Page } from "playwright-core";
import { ChatGptWebProvider } from "../../src/providers/chatgpt-web/ChatGptWebProvider";
import { ChatGptBrowserWorker } from "../../src/providers/chatgpt-web/upstream/src/adapters/chatgpt-web/browser-worker";
import type { AttachmentStore } from "../../src/ports/AttachmentStore";

export const fixtureRemote = "00000000-0000-4000-8000-000000000001";
export class BrowserFixture {
  context?: BrowserContext;
  launchOptions?: Parameters<typeof chromium.launchPersistentContext>[1];
  mutationPage?: Page;
  auth: "ready" | "missing" | "malformed" | "cookie" = "ready";
  dropAfterSubmit = false;
  failUpload = false;
  uploadChipLimit?: number;
  nestedUploadSurface = false;
  onUpload?: (page: Page) => void;
  autoComplete = false;
  submissions: {
    text: string;
    files: { name: string; mimeType: string; base64: string }[];
    path: string;
  }[] = [];
  uploads = 0;
  network: string[] = [];
  constructor(
    readonly profileDir: string,
    readonly executablePath: string,
  ) {}

  provider(attachmentStore?: AttachmentStore): ChatGptWebProvider {
    const session = ChatGptBrowserWorker.forGateway({
      profileDir: this.profileDir,
      executablePath: this.executablePath,
      headless: true,
      launch: async (path, options) => {
        this.launchOptions = options;
        // Synthetic authentication must stay independent of the operator's OS keychain.
        // Production launch options are recorded/asserted before this fixture-only override.
        const context = await chromium.launchPersistentContext(path, {
          ...options,
          ignoreDefaultArgs: [],
        });
        this.context = context;
        await context.route("**/*", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          this.network.push(url.origin + url.pathname);
          if (url.origin !== "https://chatgpt.com") {
            await route.abort();
            return;
          }
          if (url.pathname === "/api/auth/session") {
            const cookie = request.headers().cookie ?? "";
            const authenticated =
              this.auth === "ready" ||
              (this.auth === "cookie" && cookie.includes("gateway_fixture_auth=synthetic"));
            await route.fulfill({
              contentType: "application/json",
              body:
                this.auth === "malformed"
                  ? "invalid"
                  : JSON.stringify(
                      authenticated
                        ? { user: { id: "synthetic" }, expires: "2099-01-01T00:00:00Z" }
                        : {},
                    ),
            });
          } else if (url.pathname === "/fixture/submit") {
            this.mutationPage = request.frame().page();
            this.submissions.push(request.postDataJSON());
            await route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({
                remote: fixtureRemote,
                drop: this.dropAfterSubmit,
                autoComplete: this.autoComplete,
              }),
            });
            if (this.dropAfterSubmit) await this.mutationPage.close();
          } else if (url.pathname === "/fixture/upload") {
            this.uploads++;
            await route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({
                fail: this.failUpload,
                chipLimit: this.uploadChipLimit,
                nestedSurface: this.nestedUploadSurface,
              }),
            });
            this.onUpload?.(request.frame().page());
            if (this.failUpload) await request.frame().page().close();
          } else if (url.pathname === "/" || url.pathname === `/c/${fixtureRemote}`) {
            await route.fulfill({
              contentType: "text/html",
              body: this.html(url.pathname !== "/"),
            });
          } else {
            await route.fulfill({ status: 404, contentType: "text/html", body: this.html(false) });
          }
        });
        return context;
      },
    });
    return new ChatGptWebProvider({ profileDir: this.profileDir, session, attachmentStore });
  }

  private html(existing: boolean): string {
    return `<!doctype html><html><body>
      <main id="history">${existing ? '<article data-turn-id-container="old-user"><section data-testid="conversation-turn-0" data-turn="user" data-turn-id="old-user">old user</section></article><article data-turn-id-container="old-answer"><section data-testid="conversation-turn-1" data-turn="assistant" data-turn-id="old-answer"><div class="markdown"><p>old answer must never be returned</p></div><button data-testid="copy-turn-action-button">Copy</button></section></article>' : ""}</main>
      <form data-chatgpt-composer><div id="prompt-textarea" data-testid="prompt-textarea" contenteditable="plaintext-only" style="min-height:40px"></div><input type="file" multiple data-testid="upload-photos-input"><div id="uploads"></div><button type="submit" data-testid="send-button">Send</button></form>
      <script>
      const form=document.querySelector('form'), composer=document.querySelector('#prompt-textarea'), input=document.querySelector('input'), historyRoot=document.querySelector('#history');
      // Track browser input events as editor state: innerText adds layout-only newlines to empty blocks.
      let promptValue=''; composer.addEventListener('input',event=>{promptValue+=event.data??'\\n';});
      input.addEventListener('change', async()=>{ const result=await (await fetch('/fixture/upload')).json(); if(result.fail){ window.close(); return; } for(const file of [...input.files].slice(0,result.chipLimit)){ const group=document.createElement('div'); group.setAttribute('role','group'); group.setAttribute('aria-label',file.name); group.textContent=file.name; if(result.nestedSurface){const surface=document.createElement('button');surface.className='composer-attachment-surface';surface.setAttribute('aria-label',file.name);surface.textContent=file.name;group.append(surface);} document.querySelector('#uploads').append(group); } });
      form.addEventListener('submit',async event=>{event.preventDefault(); const files=[]; for(const file of input.files){const bytes=new Uint8Array(await file.arrayBuffer()); files.push({name:file.name,mimeType:file.type,base64:btoa(String.fromCharCode(...bytes))});} const result=await (await fetch('/fixture/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:promptValue,files,path:location.pathname})})).json(); if(result.drop){window.close();return;} history.replaceState({},'', '/c/'+result.remote); composer.textContent='';
      historyRoot.insertAdjacentHTML('beforeend','<article data-turn-id-container="new-user"><section data-testid="conversation-turn-2" data-turn="user" data-turn-id="new-user">accepted user</section></article><article data-turn-id-container="new-answer"><section data-testid="conversation-turn-3" data-turn="assistant" data-turn-id="new-answer"><div class="markdown"><p>partial answer</p></div></section></article>'); const stop=document.createElement('button'); stop.dataset.testid='stop-button'; stop.textContent='Stop'; document.body.append(stop); if(result.autoComplete)setTimeout(()=>window.fixtureFinish(),50); });
      window.fixtureFinish=()=>{document.querySelector('[data-testid="stop-button"]')?.remove();const answer=document.querySelector('[data-turn-id="new-answer"]');answer.querySelector('.markdown').innerHTML='<p>final answer</p><pre><code>const x = 1;</code></pre>'; answer.insertAdjacentHTML('beforeend','<button data-testid="copy-turn-action-button">Copy</button>');};
      window.fixtureForeign=()=>{historyRoot.insertAdjacentHTML('beforeend','<article data-turn-id-container="foreign-user"><section data-testid="conversation-turn-4" data-turn="user" data-turn-id="foreign-user">foreign</section></article>');};
      </script></body></html>`;
  }

  async finish(): Promise<void> {
    if (!this.mutationPage) throw new Error("Fixture has no submitted page");
    await this.mutationPage.evaluate(() =>
      (window as unknown as { fixtureFinish(): void }).fixtureFinish(),
    );
  }
  async foreignTurn(): Promise<void> {
    if (!this.mutationPage) throw new Error("Fixture has no submitted page");
    await this.mutationPage.evaluate(() =>
      (window as unknown as { fixtureForeign(): void }).fixtureForeign(),
    );
  }
}
