// Single source of every user-facing Korean string. docs/SPEC.md is canonical — do not reword.

export const strings = {
  start: {
    greeting: "반갑습니다! Gemini AI 봇입니다. 🤖\n\n<b>사용 가능한 명령어:</b>\n",
    footer: "\n명령어를 입력하거나, 궁금한 점을 자연스럽게 물어보세요!",
  },

  help: {
    listHeader: "<b>사용 가능한 명령어:</b>\n\n",
    listFooter: "\n/help [명령어] 를 입력하면 자세한 사용법을 볼 수 있습니다.",
    paramsHeader: "\n<b>매개변수:</b>\n",
    defaultValue: (value: string) => ` (기본값: ${value})`,
    aliases: (joined: string) => `별칭: ${joined}\n`,
    unknownCommand: (name: string) => `알 수 없는 명령어입니다: ${name}`,
  },

  menu: {
    aliasDescription: (mainCommand: string, description: string) =>
      `/${mainCommand}의 별칭. ${description}`,
  },

  validate: {
    replyToBotNeedsContent: "봇의 응답이나 다른 명령어에는 내용을 입력하여 답장해야 합니다.",
    needPromptOrReply:
      "명령어와 함께 프롬프트를 입력하거나, 내용이 있는 메시지에 답장하며 사용해주세요.",
  },

  errors: {
    promptBlocked: (reason: string) => `프롬프트 차단됨: ${reason}`,
    safetyBlocked: "생성된 내용이 안전 정책에 의해 차단되었습니다.",
    malformedFunctionCall: "함수 호출 오류입니다.",
    emptyResponse: "응답에 데이터가 없습니다.",
    overloaded:
      "현재 AI 모델의 접속량이 많아 처리가 지연되고 있습니다. 잠시 후 다시 시도해주세요. (503)",
    rateLimited: "요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요. (429)",
    timeout: "AI 응답 대기 시간이 초과되었습니다. (Timeout)",
    apiError: "API 오류가 발생했습니다.",
    unexpected: "오류가 발생했습니다.",
    filesTooLarge: (totalMb: number) => `총 파일 용량이 100MB를 초과할 수 없습니다. (${totalMb}MB)`,
    noValidPrompt: "프롬프트로 삼을 유효한 메시지가 없습니다.",
  },

  retry: {
    button: "🔄 재시도",
    alreadyInProgress: "이미 재처리가 진행 중입니다.",
    originalNotFound: "원본 메시지를 찾을 수 없습니다.",
    retrying: "⏳ 재시도 중입니다...",
  },

  render: {
    codeExecutionLabel: "<b>[코드 실행]</b>",
    executionResultLabel: (ok: boolean) => `<b>[실행 결과 ${ok ? "✅" : "❌"}]</b>`,
    groundingDivider: "\n---\n",
    searchQueries: (quotedJoined: string) => `🔍 <b>검색어</b>: ${quotedJoined}\n`,
    sourcesHeader: "\n📚 <b>출처</b>:\n",
    sourceLine: (anchor: string) => ` - ${anchor}\n`,
    tokenUsage: (prompt: string, output: string, thoughts: string, total: string) =>
      `\n<b>토큰</b>: 입력 ${prompt} / 출력 ${output} / 생각 ${thoughts} / 합계 ${total}\n`,
  },
} as const;
