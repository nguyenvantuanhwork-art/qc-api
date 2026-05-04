/**
 * Cấu hình tập trung cho qc-api.
 * Ưu tiên biến môi trường (`.env`): PORT, GEMINI_MODEL, GEMINI_API_KEY.
 */
export const QC_API_DEFAULT_PORT = 3001;

export function resolvePort(): number {
  const fromEnv = Number(process.env.PORT);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : QC_API_DEFAULT_PORT;
}
