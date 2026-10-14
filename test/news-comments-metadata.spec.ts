import fs from "fs";
import path from "path";

// DEAFCS-only News comments: Hasura must never let a client write these
// tables directly (every write goes through the API actions), readers only
// ever see the computed text, and a player only sees their own +1s.

const read = (file: string) =>
  fs
    .readFileSync(path.resolve("hasura/metadata", file), "utf8")
    .replace(/\r\n/g, "\n");

const roleBlocks = (yaml: string) =>
  yaml
    .split(/\n(?=  - role: )/)
    .filter((block) => block.startsWith("  - role: "))
    .map((block) => ({
      role: block.match(/role: (\w+)/)![1],
      block,
    }));

describe("news comments metadata", () => {
  const comments = read("databases/default/tables/public_news_comments.yaml");
  const votes = read("databases/default/tables/public_news_comment_votes.yaml");

  it("is tracked", () => {
    const tables = read("databases/default/tables/tables.yaml");
    expect(tables).toContain('"!include public_news_comments.yaml"');
    expect(tables).toContain('"!include public_news_comment_votes.yaml"');
  });

  it("has no insert, update or delete permissions for any role", () => {
    for (const yaml of [comments, votes]) {
      expect(yaml).not.toMatch(/(insert|update|delete)_permissions/);
    }
  });

  it("shows readers the computed text only, and only on published articles", () => {
    const blocks = roleBlocks(comments);
    expect(blocks.map((b) => b.role).sort()).toEqual(
      [
        "administrator",
        "guest",
        "match_organizer",
        "moderator",
        "streamer",
        "tournament_organizer",
        "user",
        "verified_user",
      ].sort(),
    );
    for (const { role, block } of blocks) {
      expect(block).toMatch(/computed_fields:\s*\n\s*- text/);
      expect(block).toMatch(/article:\s*\n\s*status:\s*\n\s*_eq: published/);
      const staff = [
        "moderator",
        "match_organizer",
        "tournament_organizer",
        "administrator",
      ].includes(role);
      expect(/- body\b/.test(block)).toBe(staff);
      expect(/- hidden_reason\b/.test(block)).toBe(staff);
    }
    expect(comments).toMatch(
      /name: text[\s\S]*name: news_comment_visible_body[\s\S]*session_argument: hasura_session/,
    );
  });

  it("lets a player see only their own +1s, and guests none", () => {
    const blocks = roleBlocks(votes);
    expect(blocks.map((b) => b.role)).not.toContain("guest");
    for (const { block } of blocks) {
      expect(block).toMatch(/steam_id:\s*\n\s*_eq: X-Hasura-User-Id/);
    }
  });

  it("declares the actions, with hiding for staff only", () => {
    const actions = read("actions.yaml");
    const graphql = read("actions.graphql");
    for (const name of [
      "postNewsComment",
      "editNewsComment",
      "deleteNewsComment",
      "toggleNewsCommentVote",
      "setNewsCommentHidden",
    ]) {
      expect(actions).toContain(`- name: ${name}\n`);
      expect(graphql).toContain(`  ${name}(`);
    }
    const hide = actions.match(
      /- name: setNewsCommentHidden\n[\s\S]*?comment:/,
    )![0];
    expect(hide).not.toMatch(/role: (guest|user|verified_user|streamer)\b/);
    expect(hide).toMatch(/role: moderator/);
    expect(actions).toMatch(/- name: NewsCommentOutput\n/);
    expect(actions).toMatch(/- name: NewsCommentVoteOutput\n/);
  });
});
