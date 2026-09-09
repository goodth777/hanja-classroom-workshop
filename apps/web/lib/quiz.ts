import type { QuizQuestionType, QuizSnapshot } from "@hanja/contracts";

/**
 * Vercel can publish the web bundle before Render has restarted with the
 * matching Socket.IO contract. An absent field must not blank the game screen.
 */
export function resolveQuizQuestionType(
  quiz: Pick<QuizSnapshot, "questionType"> | null | undefined,
): QuizQuestionType | "legacy_choice" {
  switch (quiz?.questionType) {
    case "reading_choice":
    case "meaning_choice":
    case "reading_input":
    case "meaning_input":
    case "hanja_choice":
      return quiz.questionType;
    default:
      return "legacy_choice";
  }
}
