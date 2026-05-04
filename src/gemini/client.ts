import { GoogleGenAI } from "@google/genai";

export function getGeminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";
}

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Thiếu biến môi trường GEMINI_API_KEY (xem .env.example).");
  }
  return new GoogleGenAI({ apiKey });
}

/** Chuẩn hóa lỗi từ Gemini API (403 suspend, quota, v.v.) cho UI. */
export function geminiErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (/CONSUMER_SUSPENDED|has been suspended/i.test(raw)) {
    return (
      "Khóa API Gemini đã bị Google tạm khóa (CONSUMER_SUSPENDED). " +
      "Hãy vào Google AI Studio (mục API key), tạo khóa mới hoặc kiểm tra thông báo tài khoản/billing/vi phạm chính sách. " +
      "Cập nhật GEMINI_API_KEY trong .env rồi khởi động lại qc-api."
    );
  }

  if (/PERMISSION_DENIED/i.test(raw) || (/403/.test(raw) && /Permission denied/i.test(raw))) {
    return (
      "Gemini từ chối quyền (403 / PERMISSION_DENIED). " +
      "Kiểm tra GEMINI_API_KEY đúng project, API Generative Language được bật, và khóa chưa bị thu hồi."
    );
  }

  if (/RESOURCE_EXHAUSTED|429|quota/i.test(raw)) {
    return "Vượt quota hoặc giới hạn tần suất Gemini. Thử lại sau hoặc kiểm tra mức sử dụng trên Google AI Studio.";
  }

  return raw.length > 2500 ? `${raw.slice(0, 2500)}…` : raw;
}
