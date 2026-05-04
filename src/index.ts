import path from "node:path";
import dotenv from "dotenv";
import cors from "cors";
import express from "express";
import puppeteer from "puppeteer";
import { resolvePort } from "./config";
import { geminiErrorMessage, getGeminiClient, getGeminiModel } from "./gemini/client";
import { testCaseRouter } from "./testCaseActions/router";
import { migrate } from "./db/migrate";
import { projectsRouter } from "./projects/router";
import { featuresRouter } from "./features/router";
import { testCasesRouter } from "./testCases/router";
import { testRunsRouter } from "./testRuns/router";
import { authRouter } from "./auth/router";
import { requireAuth } from "./auth/middleware";
import { schedulesRouter } from "./schedules/router";
import { startScheduleRunner } from "./schedules/worker";
import { reportsRouter } from "./reports/router";
import { notificationsRouter } from "./notifications/router";

// Luôn đọc `qc-api/.env` (không phụ thuộc cwd). `override: true` vì mặc định dotenv
// không ghi đè biến đã có — trên Windows User env thường còn GEMINI_API_KEY cũ.
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

const PORT = resolvePort();
const TARGET_URL = "https://acnecare.io.vn";
const geminiKey = process.env.GEMINI_API_KEY?.trim();
if (process.env.NODE_ENV !== "production" && geminiKey) {
  console.log(`[qc-api] GEMINI_API_KEY đang dùng (4 ký tự cuối): …${geminiKey.slice(-4)}`);
}

const TESTFLOW_SYSTEM_INSTRUCTION =
  "Bạn là trợ lý QA trong TestFlow AI (kiểm thử tự động, Puppeteer, test case). " +
  "Trả lời súc tích, có cấu trúc khi cần; ưu tiên tiếng Việt nếu người dùng dùng tiếng Việt.";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    app: "qc-api",
    port: PORT,
    health: "/health",
    auth: {
      register: "POST /api/auth/register",
      login: "POST /api/auth/login",
      me: "GET /api/auth/me (Bearer)",
    },
    aiHealth: "/api/ai/health",
    aiChat: "POST /api/ai/chat (Bearer)",
    aiFill: "POST /api/test-cases/:testCaseId/ai/fill (Bearer)",
    testCaseActions: "GET/POST /api/test-cases/:testCaseId/actions (Bearer)",
    testCaseRun: "POST /api/test-cases/:testCaseId/run (Bearer)",
    projects: "/api/projects (Bearer)",
    projectMembers:
      "GET/POST /api/projects/:projectId/members, DELETE /api/projects/:projectId/members/:userId",
    projectSettings: "GET/PUT /api/projects/:projectId/settings (Bearer, PUT cần quản lý dự án)",
    runHistoryGlobal: "GET /api/run-history?limit=&offset= (Bearer)",
    reportsSummary: "GET /api/reports/summary?days=&projectId= (Bearer)",
    schedules: "GET/POST /api/schedules, PUT/DELETE /api/schedules/:id (Bearer)",
    notifications:
      "GET /api/notifications?limit=&unreadOnly=, PATCH /api/notifications/:id/read, POST /api/notifications/read-all (Bearer)",
  });
});

app.use("/api/auth", authRouter);
app.use("/api/notifications", notificationsRouter);

app.use("/api/test-cases/:testCaseId", testCaseRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/projects/:projectId/features", featuresRouter);
app.use("/api/projects/:projectId/features/:featureId/test-cases", testCasesRouter);
app.use("/api", testRunsRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/schedules", schedulesRouter);

app.post("/api/ai/chat", requireAuth, async (req, res) => {
  try {
    const raw = req.body as { message?: unknown; context?: unknown };
    const message = typeof raw.message === "string" ? raw.message.trim() : "";
    const context = typeof raw.context === "string" ? raw.context.trim() : "";

    if (!message) {
      res.status(400).json({ ok: false, error: "Trường message là bắt buộc." });
      return;
    }

    const ai = getGeminiClient();
    const userText =
      context.length > 0
        ? `[Ngữ cảnh test case / trang hiện tại]\n${context}\n\n[Câu hỏi / yêu cầu]\n${message}`
        : message;

    const response = await ai.models.generateContent({
      model: getGeminiModel(),
      contents: userText,
      config: {
        systemInstruction: TESTFLOW_SYSTEM_INSTRUCTION,
        temperature: 0.5,
        maxOutputTokens: 2048,
      },
    });

    const text = response.text?.trim();
    if (!text) {
      res.status(502).json({
        ok: false,
        error: "Gemini không trả về nội dung (kiểm tra model, quota hoặc nội dung bị chặn).",
      });
      return;
    }

    res.json({ ok: true, text, model: getGeminiModel() });
  } catch (err) {
    const message = geminiErrorMessage(err);
    console.error("[api/ai/chat]", err instanceof Error ? err.message : err);
    res.status(500).json({ ok: false, error: message });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/** Kiểm tra nhanh: GET /api/ai/health — phải trả 200 khi qc-api đã bật đúng bản có Gemini. */
app.get("/api/ai/health", (_req, res) => {
  res.json({
    ok: true,
    service: "qc-api",
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
    model: getGeminiModel(),
  });
});


app.post("/api/demo/acnecare-login", requireAuth, async (_req, res) => {
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 60_000 });

    const clicked = await page.evaluate(() => {
      const nodes = document.querySelectorAll("a, button, [role='button']");
      for (const el of nodes) {
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
        if (text.includes("đăng nhập") || text.includes("dang nhap")) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    });

    if (!clicked) {
      res.status(422).json({
        ok: false,
        error: "Không tìm thấy nút Đăng nhập trên trang.",
      });
      return;
    }

    await new Promise((r) => setTimeout(r, 1500));
    const screenshot = await page.screenshot({ type: "png", fullPage: false });
    const base64 = Buffer.from(screenshot).toString("base64");

    res.json({
      ok: true,
      url: page.url(),
      screenshotBase64: base64,
      mimeType: "image/png",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  } finally {
    await browser?.close();
  }
});

void (async () => {
  try {
    await migrate();
  } catch (err) {
    console.error("[db:migrate]", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  app.listen(PORT, () => {
    startScheduleRunner();
    console.log(`QC API listening on http://localhost:${PORT}`);
    console.log(`  GET  http://localhost:${PORT}/  (nhận diện server)`);
    console.log(`  GET  http://localhost:${PORT}/health`);
    console.log(`  GET  http://localhost:${PORT}/api/ai/health`);
    console.log(`  POST http://localhost:${PORT}/api/ai/chat`);
    console.log(`  POST http://localhost:${PORT}/api/test-cases/:id/ai/fill`);
    console.log(`  GET/POST http://localhost:${PORT}/api/test-cases/:id/actions`);
    console.log(`  POST http://localhost:${PORT}/api/test-cases/:id/run`);
  });
})();
