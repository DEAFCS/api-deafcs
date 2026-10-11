import { ChatGateway } from "./chat.gateway";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

describe("Upstream correlated chat actions with DEAFCS authorization", () => {
  const messageId="123e4567-e89b-42d3-a456-426614174000";
  let gateway: ChatGateway, chat: any, client: any;
  beforeEach(() => {
    chat={editChatMessage:jest.fn().mockResolvedValue(true),editAnnouncement:jest.fn().mockResolvedValue(true),deleteMessage:jest.fn().mockResolvedValue(true),toggleChatMessageReaction:jest.fn().mockResolvedValue(true)};
    gateway=new ChatGateway(chat);client={user:{steam_id:"1"},send:jest.fn()};
  });
  const data={id:"global",type:ChatLobbyType.Global,messageId,requestId:"synthetic-request"};
  const reply=()=>JSON.parse(client.send.mock.calls.at(-1)[0]);
  it("delegates edits to existing authorization and returns a correlated ack",async()=>{
    await gateway.editMessageRequest({...data,message:"fixed"},client);
    expect(chat.editChatMessage).toHaveBeenCalledWith(client,data.type,data.id,messageId,"fixed");
    expect(reply()).toEqual({event:"chat:ack",data:{requestId:data.requestId,messageId,action:"edit"}});
  });
  it.each(["direct","tournament","match","match_team","captain_pick_team","draft"])("preserves %s routing without inventing room access",async(type)=>{
    await gateway.deleteMessageRequest({...data,type:type as ChatLobbyType},client);
    expect(chat.deleteMessage).toHaveBeenCalledWith(client,type,"global",messageId);
  });
  it("never turns a permission refusal into success",async()=>{
    chat.editChatMessage.mockResolvedValue(false);await gateway.editMessageRequest({...data,message:"fixed"},client);
    expect(reply()).toMatchObject({event:"chat:error",data:{requestId:data.requestId,action:"edit",code:"not_allowed"}});
  });
  it("rejects over-length input before reaching persistence",async()=>{
    await gateway.editMessageRequest({...data,message:"x".repeat(2001)},client);expect(chat.editChatMessage).not.toHaveBeenCalled();
    expect(reply()).toMatchObject({event:"chat:error",data:{code:"too_long",max:2000}});
  });
  it("keeps announcements scoped to their canonical room",async()=>{
    await gateway.editMessageRequest({...data,type:ChatLobbyType.Announcement,id:"foreign",message:"fixed"},client);
    expect(chat.editAnnouncement).not.toHaveBeenCalled();expect(reply().event).toBe("chat:error");
    await gateway.editMessageRequest({...data,type:ChatLobbyType.Announcement,id:"announcement",message:"fixed"},client);
    expect(chat.editAnnouncement).toHaveBeenCalledWith(client,messageId,"fixed");
  });
  it("rejects unauthenticated and invalid-room requests before calling the service",async()=>{
    client.user=undefined;await gateway.reactionRequest({...data,reaction:"party"},client);
    client.user={steam_id:"1"};await gateway.reactionRequest({...data,type:"foreign" as ChatLobbyType,reaction:"party"},client);
    expect(chat.toggleChatMessageReaction).not.toHaveBeenCalled();
  });
  it.each(["party","tada"])("keeps the %s reaction ID unchanged",async(reaction)=>{
    await gateway.reactionRequest({...data,reaction},client);expect(chat.toggleChatMessageReaction).toHaveBeenCalledWith(client,data.type,data.id,messageId,reaction);
    expect(reply()).toMatchObject({event:"chat:ack",data:{action:"react"}});
  });
});
