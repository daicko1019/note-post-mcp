#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import 'dotenv/config';

// 名称一貫性
const SERVER_NAME = process.env.MCP_NAME ?? 'note-post-mcp';
const SERVER_VERSION = '1.0.0';

// 環境変数デフォルト
const DEFAULT_STATE_PATH = process.env.NOTE_POST_MCP_STATE_PATH ?? 
  path.join(os.homedir(), '.note-state.json');
const DEFAULT_TIMEOUT = parseInt(process.env.NOTE_POST_MCP_TIMEOUT ?? '180000', 10);

// ログ用ユーティリティ
function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [${SERVER_NAME}] ${message}`, data ?? '');
}

// aria-label はボタン自身に付く場合と、内側の svg に付く場合がある（2026-08 の UI 変更で svg 側へ移動）
function byAriaLabel(page: Page, label: string): Locator {
  return page.locator(`button[aria-label="${label}"], button:has(svg[aria-label="${label}"])`);
}

// 公開の成否は画面ではなく記事の状態で判定する。投稿後も URL が /publish/ のまま残ることがあり、
// 画面の変化や固定の待ち時間で判定すると、失敗しても成功と返してしまう（2026-09 確認）
async function waitForPublished(context: BrowserContext, editorUrl: string, timeoutMs = 30000): Promise<string | null> {
  const key = editorUrl.match(/\/notes\/(n[0-9a-z]+)\//)?.[1];
  if (!key) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await context.request.get(`https://note.com/api/v3/notes/${key}`).catch(() => null);
    const data = res && res.ok() ? (await res.json().catch(() => null))?.data : null;
    if (data?.status === 'published') return data.note_url || `https://note.com/notes/${key}`;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}

// 現在時刻のフォーマット
function nowStr(): string {
  const d = new Date();
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
}

// 画像情報の型定義
interface ImageInfo {
  alt: string;
  localPath: string;
  absolutePath: string;
  placeholder: string;
}

// Markdownから画像パスを抽出する関数
function extractImages(markdown: string, baseDir: string): ImageInfo[] {
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const images: ImageInfo[] = [];
  let match;

  while ((match = imageRegex.exec(markdown)) !== null) {
    const alt = match[1] || 'image';
    const imagePath = match[2];
    
    // URLではなくローカルパスの場合のみ処理
    if (!imagePath.startsWith('http://') && !imagePath.startsWith('https://')) {
      const absolutePath = path.resolve(baseDir, imagePath);
      if (fs.existsSync(absolutePath)) {
        images.push({
          alt,
          localPath: imagePath,
          absolutePath,
          placeholder: match[0], // 元のマークダウン記法全体
        });
      } else {
        log(`Warning: Image file not found: ${absolutePath}`);
      }
    }
  }

  return images;
}

// Markdownファイルをパースする関数
function parseMarkdown(content: string): {
  title: string;
  body: string;
  tags: string[];
} {
  // CRLF のままだと各行末の \r が keyboard.type で Enter として打たれ、段落が分かれて空行が増える（2026-09 確認）
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  let title = '';
  let body = '';
  const tags: string[] = [];
  let inFrontMatter = false;
  let frontMatterEnded = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Front matter の処理（YAML形式）
    if (line.trim() === '---') {
      if (!frontMatterEnded) {
        inFrontMatter = !inFrontMatter;
        if (!inFrontMatter) {
          frontMatterEnded = true;
        }
        continue;
      }
    }

    if (inFrontMatter) {
      // タイトルとタグをfront matterから抽出
      if (line.startsWith('title:')) {
        title = line.substring(6).trim().replace(/^["']|["']$/g, '');
      } else if (line.startsWith('tags:')) {
        const tagsStr = line.substring(5).trim();
        if (tagsStr.startsWith('[') && tagsStr.endsWith(']')) {
          // 配列形式: tags: [tag1, tag2]
          tags.push(...tagsStr.slice(1, -1).split(',').map(t => t.trim().replace(/^["']|["']$/g, '')));
        }
      } else if (line.trim().startsWith('-')) {
        // 配列形式: - tag1
        const tag = line.trim().substring(1).trim().replace(/^["']|["']$/g, '');
        if (tag) tags.push(tag);
      }
      continue;
    }

    // タイトルを # から抽出（front matterがない場合）
    if (!title && line.startsWith('# ')) {
      title = line.substring(2).trim();
      continue;
    }

    // 本文を追加
    if (frontMatterEnded || !line.trim().startsWith('---')) {
      body += line + '\n';
    }
  }

  return {
    title: title || 'Untitled',
    body: body.trim(),
    tags: tags.filter(Boolean),
  };
}

// note.com投稿関数
async function postToNote(params: {
  markdownPath: string;
  thumbnailPath?: string;
  statePath?: string;
  isPublic: boolean;
  screenshotDir?: string;
  timeout?: number;
}): Promise<{
  success: boolean;
  url: string;
  screenshot?: string;
  message: string;
  warnings?: string[];
}> {
  const {
    markdownPath,
    thumbnailPath,
    statePath = DEFAULT_STATE_PATH,
    isPublic,
    screenshotDir = path.join(os.tmpdir(), 'note-screenshots'),
    timeout = DEFAULT_TIMEOUT,
  } = params;

  // Markdownファイルを読み込み
  if (!fs.existsSync(markdownPath)) {
    throw new Error(`Markdown file not found: ${markdownPath}`);
  }
  const mdContent = fs.readFileSync(markdownPath, 'utf-8');
  const { title, body, tags } = parseMarkdown(mdContent);
  
  // 本文中の画像を抽出
  const baseDir = path.dirname(markdownPath);
  const images = extractImages(body, baseDir);

  log('Parsed markdown', { title, bodyLength: body.length, tags, imageCount: images.length });

  // 認証状態ファイルを確認
  if (!fs.existsSync(statePath)) {
    throw new Error(`State file not found: ${statePath}. Please login first.`);
  }

  // スクリーンショットディレクトリを作成
  fs.mkdirSync(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `note-post-${nowStr()}.png`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--lang=ja-JP'],
  });

  try {
    // UA に HeadlessChrome が入ると editor.note.com → note.com/api の CORS プリフライトが拒否され、エディタが開かない（2026-09 確認）
    const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
    const context = await browser.newContext({
      storageState: statePath,
      locale: 'ja-JP',
      userAgent: `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    
    // クリップボード権限を明示的に付与
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://editor.note.com' });

    // 新規記事作成ページに移動
    const startUrl = 'https://editor.note.com/new';
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForSelector('textarea[placeholder*="タイトル"]', { timeout });

    // サムネイル画像の設定
    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
      log('Uploading thumbnail image');
      const candidates = byAriaLabel(page, '画像を追加');
      await candidates.first().waitFor({ state: 'visible', timeout });

      let target = candidates.first();
      const cnt = await candidates.count();
      if (cnt > 1) {
        let minY = Infinity;
        let idx = 0;
        for (let i = 0; i < cnt; i++) {
          const box = await candidates.nth(i).boundingBox();
          if (box && box.y < minY) {
            minY = box.y;
            idx = i;
          }
        }
        target = candidates.nth(idx);
      }

      await target.scrollIntoViewIfNeeded();
      await target.click({ force: true });

      const uploadBtn = page.locator('button:has-text("画像をアップロード")').first();
      await uploadBtn.waitFor({ state: 'visible', timeout });

      let chooser = null;
      try {
        [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 5000 }),
          uploadBtn.click({ force: true }),
        ]);
      } catch (_) {
        // フォールバック
      }

      if (chooser) {
        await chooser.setFiles(thumbnailPath);
      } else {
        await uploadBtn.click({ force: true }).catch(() => {});
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.waitFor({ state: 'attached', timeout });
        await fileInput.setInputFiles(thumbnailPath);
      }

      // トリミングダイアログ内「保存」を押す
      const dialog = page.locator('div[role="dialog"]');
      await dialog.waitFor({ state: 'visible', timeout });

      const saveThumbBtn = dialog.locator('button:has-text("保存")').first();
      const cropper = dialog.locator('[data-testid="cropper"]').first();

      const cropperEl = await cropper.elementHandle();
      const saveEl = await saveThumbBtn.elementHandle();

      if (cropperEl && saveEl) {
        await Promise.race([
          page.waitForFunction(
            (el) => getComputedStyle(el as Element).pointerEvents === 'none',
            cropperEl,
            { timeout }
          ),
          page.waitForFunction(
            (el) => !(el as HTMLButtonElement).disabled,
            saveEl,
            { timeout }
          ),
        ]);
      }

      await saveThumbBtn.click();
      await dialog.waitFor({ state: 'hidden', timeout }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout }).catch(() => {});

      // 反映確認
      const changedBtn = byAriaLabel(page, '画像を変更');
      const addBtn = byAriaLabel(page, '画像を追加');

      let applied = false;
      try {
        await changedBtn.waitFor({ state: 'visible', timeout: 5000 });
        applied = true;
      } catch {}
      if (!applied) {
        try {
          await addBtn.waitFor({ state: 'hidden', timeout: 5000 });
          applied = true;
        } catch {}
      }
      if (!applied) {
        log('Thumbnail reflection uncertain, continuing');
      }
    }

    // タイトル設定
    await page.fill('textarea[placeholder*="タイトル"]', title);
    log('Title set');

    // 本文設定（行ごとに処理してURLをリンクカードに変換、画像を埋め込む）
    const bodyBox = page.locator('div[contenteditable="true"][role="textbox"]').first();
    await bodyBox.waitFor({ state: 'visible' });
    await bodyBox.click();
    
    const lines = body.split('\n');
    let previousLineWasList = false; // 前の行がリスト項目だったかを追跡
    let previousLineWasQuote = false; // 前の行が引用だったかを追跡
    let previousLineWasHorizontalRule = false; // 前の行が水平線だったかを追跡
    const imageCaptions: string[] = []; // 貼り付けた画像の alt（本文入力後にキャプションとして入れる）
    const warnings: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLastLine = i === lines.length - 1;
      
      // コードブロックの開始を検出
      if (line.trim().startsWith('```')) {
        // コードブロック全体（```から```まで）を収集
        const codeBlockLines: string[] = [line]; // 開始行を含める
        let j = i + 1;
        
        // 終了行まで収集
        while (j < lines.length) {
          codeBlockLines.push(lines[j]);
          if (lines[j].trim().startsWith('```')) {
            break; // 終了行を含めて終了
          }
          j++;
        }
        
        // コードブロック全体をクリップボードにコピー
        const codeBlockContent = codeBlockLines.join('\n');
        
        await page.evaluate((text) => {
          return navigator.clipboard.writeText(text);
        }, codeBlockContent);
        
        await page.waitForTimeout(200);
        
        // ペースト
        const isMac = process.platform === 'darwin';
        if (isMac) {
          await page.keyboard.press('Meta+v');
        } else {
          await page.keyboard.press('Control+v');
        }
        
        await page.waitForTimeout(300);
        
        // コードブロックの後に改行（最終行でない場合）
        if (j < lines.length - 1) {
          await page.keyboard.press('Enter');
        }
        
        // iをコードブロック終了行まで進める
        i = j;
        
        // フラグをリセット
        previousLineWasList = false;
        previousLineWasQuote = false;
        previousLineWasHorizontalRule = false;
        continue;
      }
      
      // 次の行が水平線かどうかをチェック
      const nextLine = i < lines.length - 1 ? lines[i + 1] : '';
      const nextLineIsHorizontalRule = nextLine.trim() === '---';
      
      // 水平線の直後の空行をスキップ
      if (previousLineWasHorizontalRule && line.trim() === '') {
        previousLineWasHorizontalRule = false;
        continue; // 空行をスキップ
      }
      previousLineWasHorizontalRule = false;
      
      // 画像マークダウンを検出
      const imageMatch = line.match(/!\[([^\]]*)\]\(([^)]+)\)/);
      if (imageMatch) {
        const imagePath = imageMatch[2];
        // ローカルパスの画像をアップロード
        if (!imagePath.startsWith('http://') && !imagePath.startsWith('https://')) {
          const imageInfo = images.find(img => img.localPath === imagePath);
          if (imageInfo && fs.existsSync(imageInfo.absolutePath)) {
            log('Pasting inline image', { path: imageInfo.absolutePath });
            
            // 画像をクリップボードにコピーしてペーストする方法
            // 1. 前の行の処理（または本文の先頭）で既に新しい行にいるので、ここでは改行しない。
            //    改行すると画像の前に空行が1つ残る（2026-09 確認）。
            //    ただしリスト・引用の直後は空の項目の中にいるので、改行して抜けてから貼る
            if (previousLineWasList || previousLineWasQuote) {
              await page.keyboard.press('Enter');
              await page.waitForTimeout(300);
            }
            const figuresBefore = await bodyBox.locator('figure:has(img)').count();
            // 2. 画像ファイルをクリップボードにコピー
            const imageBuffer = fs.readFileSync(imageInfo.absolutePath);
            const base64Image = imageBuffer.toString('base64');
            const mimeType = imageInfo.absolutePath.endsWith('.png') ? 'image/png' : 
                           imageInfo.absolutePath.endsWith('.jpg') || imageInfo.absolutePath.endsWith('.jpeg') ? 'image/jpeg' :
                           imageInfo.absolutePath.endsWith('.gif') ? 'image/gif' : 'image/png';
            
            // クリップボードに画像を設定するためのJavaScriptを実行
            await page.evaluate(async ({ base64, mime }) => {
              const response = await fetch(`data:${mime};base64,${base64}`);
              let blob = await response.blob();
              // Clipboard API は image/png しか書き込めないため、JPEG/GIF は canvas で PNG に変換する
              if (mime !== 'image/png') {
                const bitmap = await createImageBitmap(blob);
                const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
                canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
                blob = await canvas.convertToBlob({ type: 'image/png' });
              }
              const item = new ClipboardItem({ 'image/png': blob });
              await navigator.clipboard.write([item]);
            }, { base64: base64Image, mime: mimeType });
            
            await page.waitForTimeout(500);
            
            // 3. Cmd+V (macOS) または Ctrl+V でペースト
            const isMac = process.platform === 'darwin';
            if (isMac) {
              await page.keyboard.press('Meta+v');
            } else {
              await page.keyboard.press('Control+v');
            }
            
            // ペースト完了を待つ。画像が本文に入り、アップロードが終わるまで待つ。
            // 固定の待ち時間だと、新規記事の最初の貼り付けで画像が入る前に次の Enter が押され、
            // 後から入った画像のキャプションへキャレットが移って本文がキャプションに入った（2026-09 確認）
            const uploaded = await page.waitForFunction((before) => {
              const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('div[contenteditable="true"][role="textbox"] figure img'));
              return imgs.length > before && imgs.every((img) => /^https:\/\/assets\.st-note\.com\//.test(img.src));
            }, figuresBefore, { timeout: 30000 }).then(() => true).catch(() => false);
            if (!uploaded) {
              warnings.push(`画像のアップロードを確認できませんでした: ${imagePath}`);
            }
            await page.waitForTimeout(300);

            log('Inline image pasted');
            imageCaptions.push(imageMatch[1]);

            // 画像の後に改行してテキストボックスに戻る
            if (!isLastLine) {
              await page.keyboard.press('Enter');
            }
            previousLineWasList = false; // 画像の後はリストではない
            previousLineWasQuote = false; // 画像の後は引用ではない
            previousLineWasHorizontalRule = false; // 画像の後は水平線ではない
            continue; // 次の行へ
          }
        }
      }
      
      // 水平線かどうかをチェック
      const isHorizontalRule = line.trim() === '---';
      
      // 現在の行がリスト項目かどうかをチェック
      const isBulletList = /^(\s*)- /.test(line);
      const isNumberedList = /^(\s*)\d+\.\s/.test(line);
      const isCurrentLineList = isBulletList || isNumberedList;
      
      // 現在の行が引用かどうかをチェック
      const isQuote = /^>/.test(line);
      
      // 通常のテキスト行を入力
      let processedLine = line;
      
      // 前の行がリスト項目で、現在の行もリスト項目なら、マークダウン記号を削除
      if (previousLineWasList && isCurrentLineList) {
        // 箇条書きリスト: "- " または "  - " などを削除
        // 先頭のスペース（インデント）を保持しつつ、"- " だけを削除
        if (isBulletList) {
          processedLine = processedLine.replace(/^(\s*)- /, '$1');
        }
        
        // 番号付きリスト: "1. " または "  1. " などを削除
        // 先頭のスペース（インデント）を保持しつつ、"数字. " だけを削除
        if (isNumberedList) {
          processedLine = processedLine.replace(/^(\s*)\d+\.\s/, '$1');
        }
      }
      
      // 前の行が引用で、現在の行も引用なら、マークダウン記号を削除
      if (previousLineWasQuote && isQuote) {
        // 引用: "> " を削除
        processedLine = processedLine.replace(/^>\s?/, '');
      }
      
      await page.keyboard.type(processedLine);
      
      // 次の行のために、現在の行の状態を記録
      previousLineWasList = isCurrentLineList;
      previousLineWasQuote = isQuote;
      previousLineWasHorizontalRule = isHorizontalRule;
      
      // URL単独行の場合、追加でEnterを押してリンクカード化をトリガー
      const isUrlLine = /^https?:\/\/[^\s]+$/.test(line.trim());
      if (isUrlLine) {
        await page.keyboard.press('Enter');
        // リンクカード展開のアニメーション完了を待機
        await page.waitForTimeout(1200);

        // 次の行がある場合、キャレットがカード内に残らないよう、確実に次段落へ移動
        if (!isLastLine) {
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(150);
        }
      } else {
        // URL以外の行の場合のみ、最後の行でなければ改行
        if (!isLastLine) {
          await page.keyboard.press('Enter');
        }
      }
    }
    
    log('Body set');

    // 本文が画像で始まると、エディタに最初からある空段落が画像の上に残る。
    // その段落で Delete を押すと、段落が消えて下の画像が選択された状態になる。
    // キャプションを入れた後だとキャレットがキャプションに残ることがあるので、その前にやる
    const hasLeadingBlank = () => bodyBox.evaluate((el) => {
      const first = el.firstElementChild;
      return !!first && first.tagName === 'P' && !first.textContent?.trim() && first.nextElementSibling?.tagName === 'FIGURE';
    });
    if (await hasLeadingBlank()) {
      // 新規記事では最初の Delete が効かないことがある（段落に class が付くだけ）。先頭へ移動して押し直す
      for (let attempt = 0; attempt < 3 && (await hasLeadingBlank()); attempt++) {
        if (attempt === 0) {
          await bodyBox.locator(':scope > p').first().click();
        } else {
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
        }
        await page.keyboard.press('Delete');
        await page.waitForTimeout(800);
      }
      if (await hasLeadingBlank()) {
        warnings.push('本文の先頭の空行を消せませんでした');
      } else {
        log('Leading blank paragraph removed');
      }
    }

    // 画像キャプション: 入力中にキャプションへ移るとキャレット位置が崩れるため、本文を入れ終えてから入れる。
    // 引用やリンクカードも figure だが img を含まないので、figure:has(img) で画像だけを数える。
    const imageFigures = bodyBox.locator('figure:has(img)');
    const figureCount = await imageFigures.count();
    if (figureCount !== imageCaptions.length) {
      warnings.push(`画像の数が合わないためキャプションを入れていません（本文の画像 ${figureCount} / 貼り付け ${imageCaptions.length}）`);
    } else {
      for (let i = 0; i < imageCaptions.length; i++) {
        if (!imageCaptions[i].trim()) continue;
        const caption = imageFigures.nth(i).locator('figcaption');
        await caption.scrollIntoViewIfNeeded();
        await caption.click();
        await page.keyboard.type(imageCaptions[i]);
        if ((await caption.textContent())?.trim() !== imageCaptions[i].trim()) {
          warnings.push(`キャプションが入りませんでした: ${imageCaptions[i]}`);
        }
      }
    }

    // 目次: 本文中の「[目次]」だけの段落を空にし、挿入メニューの「目次」で置き換える
    const tocMarker = bodyBox.locator('p', { hasText: /^\s*\[目次\]\s*$/ }).first();
    if (await tocMarker.count()) {
      try {
        await tocMarker.click();
        await page.keyboard.press('End');
        await page.keyboard.press('Shift+Home');
        await page.keyboard.press('Backspace');
        await byAriaLabel(page, 'メニューを開く').last().click({ timeout: 5000 });
        await page.locator('button#toc-setting').click({ timeout: 5000 });
        await page.waitForTimeout(1000);
        if (!(await bodyBox.locator('table-of-contents').count())) throw new Error('目次ブロックが見つからない');
        log('Table of contents inserted');
      } catch (e) {
        await page.keyboard.press('Escape').catch(() => {});
        warnings.push(`目次を入れられませんでした: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    }
    if (warnings.length) log('Warnings', warnings);

    // 下書き保存の場合
    if (!isPublic) {
      const saveBtn = page.locator('button:has-text("下書き保存"), [aria-label*="下書き保存"]').first();
      await saveBtn.waitFor({ state: 'visible', timeout });
      if (await saveBtn.isEnabled()) {
        await saveBtn.click();
        await page.locator('text=保存しました').waitFor({ timeout: 4000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      }

      await page.screenshot({ path: screenshotPath, fullPage: true });
      const finalUrl = page.url();
      log('Draft saved', { url: finalUrl });

      await context.close();
      await browser.close();

      return {
        success: true,
        url: finalUrl,
        screenshot: screenshotPath,
        message: '下書きを保存しました',
        ...(warnings.length ? { warnings } : {}),
      };
    }

    // 公開に進む
    const proceedBtn = page.locator('button:has-text("公開に進む")').first();
    await proceedBtn.waitFor({ state: 'visible', timeout });
    for (let i = 0; i < 20; i++) {
      if (await proceedBtn.isEnabled()) break;
      await page.waitForTimeout(100);
    }
    await proceedBtn.click({ force: true });

    // 公開ページへ遷移
    await Promise.race([
      page.waitForURL(/\/publish/i, { timeout }).catch(() => {}),
      page.locator('button:has-text("投稿する")').first().waitFor({ state: 'visible', timeout }).catch(() => {}),
    ]);

    // タグ入力
    if (tags.length > 0) {
      log('Adding tags', { tags });
      let tagInput = page.locator('input[placeholder*="ハッシュタグ"]');
      if (!(await tagInput.count())) {
        tagInput = page.locator('input[role="combobox"]').first();
      }
      await tagInput.waitFor({ state: 'visible', timeout });
      for (const tag of tags) {
        await tagInput.click();
        await tagInput.fill(tag);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(120);
      }
    }

    // 投稿する
    const publishBtn = page.locator('button:has-text("投稿する")').first();
    await publishBtn.waitFor({ state: 'visible', timeout });
    for (let i = 0; i < 20; i++) {
      if (await publishBtn.isEnabled()) break;
      await page.waitForTimeout(100);
    }
    await publishBtn.click({ force: true });

    // 投稿完了待ち
    await Promise.race([
      page.waitForURL((url) => !/\/publish/i.test(url.toString()), { timeout: 20000 }).catch(() => {}),
      page.locator('text=投稿しました').first().waitFor({ timeout: 8000 }).catch(() => {}),
      page.waitForTimeout(5000),
    ]);

    const publishedUrl = await waitForPublished(context, page.url());
    await page.screenshot({ path: screenshotPath, fullPage: true });
    if (!publishedUrl) {
      throw new Error(`投稿後、記事が公開の状態になったことを確認できませんでした（下書きのまま残っている可能性があります）: ${page.url()}`);
    }
    log('Published', { url: publishedUrl });

    await context.close();
    await browser.close();

    return {
      success: true,
      url: publishedUrl,
      screenshot: screenshotPath,
      message: '記事を公開しました',
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// Zodスキーマ定義
const PublishNoteSchema = z.object({
  markdown_path: z.string().describe('Markdownファイルのパス（タイトル、本文、タグを含む）'),
  thumbnail_path: z.string().optional().describe('サムネイル画像のパス（オプション）'),
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  screenshot_dir: z.string().optional().describe('スクリーンショット保存ディレクトリ（オプション）'),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

const SaveDraftSchema = z.object({
  markdown_path: z.string().describe('Markdownファイルのパス（タイトル、本文、タグを含む）'),
  thumbnail_path: z.string().optional().describe('サムネイル画像のパス（オプション）'),
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  screenshot_dir: z.string().optional().describe('スクリーンショット保存ディレクトリ（オプション）'),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

// ツール定義
const TOOLS: Tool[] = [
  {
    name: 'publish_note',
    description: 'note.comに記事を公開します。Markdownファイルからタイトル、本文、タグを読み取り、自動的に投稿します。',
    inputSchema: {
      type: 'object',
      properties: {
        markdown_path: {
          type: 'string',
          description: 'Markdownファイルのパス（タイトル、本文、タグを含む）',
        },
        thumbnail_path: {
          type: 'string',
          description: 'サムネイル画像のパス（オプション）',
        },
        state_path: {
          type: 'string',
          description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`,
        },
        screenshot_dir: {
          type: 'string',
          description: 'スクリーンショット保存ディレクトリ（オプション）',
        },
        timeout: {
          type: 'number',
          description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`,
        },
      },
      required: ['markdown_path'],
    },
  },
  {
    name: 'save_draft',
    description: 'note.comに下書きを保存します。Markdownファイルからタイトル、本文、タグを読み取り、下書きとして保存します。',
    inputSchema: {
      type: 'object',
      properties: {
        markdown_path: {
          type: 'string',
          description: 'Markdownファイルのパス（タイトル、本文、タグを含む）',
        },
        thumbnail_path: {
          type: 'string',
          description: 'サムネイル画像のパス（オプション）',
        },
        state_path: {
          type: 'string',
          description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`,
        },
        screenshot_dir: {
          type: 'string',
          description: 'スクリーンショット保存ディレクトリ（オプション）',
        },
        timeout: {
          type: 'number',
          description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`,
        },
      },
      required: ['markdown_path'],
    },
  },
];

// MCPサーバーの初期化
const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ツール一覧ハンドラ
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// ツール呼び出しハンドラ
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'publish_note') {
      const params = PublishNoteSchema.parse(args);
      const result = await postToNote({
        markdownPath: params.markdown_path,
        thumbnailPath: params.thumbnail_path,
        statePath: params.state_path,
        screenshotDir: params.screenshot_dir,
        timeout: params.timeout,
        isPublic: true,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'save_draft') {
      const params = SaveDraftSchema.parse(args);
      const result = await postToNote({
        markdownPath: params.markdown_path,
        thumbnailPath: params.thumbnail_path,
        statePath: params.state_path,
        screenshotDir: params.screenshot_dir,
        timeout: params.timeout,
        isPublic: false,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log('Tool execution error', { name, error: errorMessage });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: false,
              error: errorMessage,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
});

// サーバー起動
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Server started', { name: SERVER_NAME, version: SERVER_VERSION });
}

main().catch((error) => {
  log('Fatal error', error);
  process.exit(1);
});

