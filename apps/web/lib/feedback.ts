import type { ErrorCode, JudgmentReason } from "@hanja/contracts";

export const judgmentMessage: Record<JudgmentReason, string> = {
  correct: "정답! 다음 획으로 넘어갑니다.",
  too_short: "조금 더 길게 그어 보세요.",
  invalid_input: "획을 인식하지 못했어요. 다시 그어 주세요.",
  start_mismatch: "시작점을 확인해 보세요.",
  end_mismatch: "끝점까지 정확하게 이어 주세요.",
  angle_mismatch: "획의 방향과 꺾임을 따라가 보세요.",
  length_mismatch: "획의 길이를 가이드에 맞춰 보세요.",
};

export const errorMessage: Partial<Record<ErrorCode, string>> = {
  INVALID_ROOM: "방 코드를 찾을 수 없습니다.",
  ROOM_FULL: "입장 인원이 가득 찼습니다.",
  ROOM_EXPIRED: "이 게임룸은 만료되었습니다.",
  RATE_LIMITED: "입장 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  NOT_YOUR_TURN: "아직 내 차례가 아닙니다.",
};
