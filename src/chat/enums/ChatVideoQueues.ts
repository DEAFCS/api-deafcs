export enum ChatVideoQueues {
  DraftExpiry = "chat-video-draft-expiry",
}

export const ExpireSentChatVideoMediaJobName = "ExpireSentChatVideoMedia";
// Files uploaded as attachments in Organizer and Team Chat, removed from
// storage when their messages expire. Runs on the same queue and worker.
export const ExpireChatAttachmentJobName = "ExpireChatAttachment";
