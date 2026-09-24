import type { Metadata } from "next";
import { LearningExperience } from "@/components/learning/learning-experience";

export const metadata: Metadata = {
  title: "Learn to evaluate AI",
  description: "A hands-on learning journey: inspect AI failures, explore evaluation architecture and leave with your own evaluation plan.",
};

export default function LearnPage() {
  return <LearningExperience />;
}
