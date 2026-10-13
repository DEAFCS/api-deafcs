import { ChatService } from '../../src/chat/chat.service';
// Legacy message/action tests isolate transport, media and rate behavior.
// Request policy itself is exercised against real PostgreSQL separately.
export function mockDirectRequestPolicy(service: ChatService) {
  jest.spyOn(service.directRequests, 'canView').mockImplementation(async (room: string, user: any) => {
    const check=(service as any).blocks?.isBlockedEitherDirection;
    const peer=room.split(':').find(id=>id!==String(user.steam_id));
    return typeof check === 'function' && peer ? !(await check(user.steam_id,peer)) : true;
  });
  jest.spyOn(service.directRequests, 'refusal').mockResolvedValue(null);
  jest.spyOn(service.directRequests, 'send').mockImplementation(async (_room: string, _user: any, action: any) => {
    const context={request:false,record:jest.fn().mockResolvedValue(undefined),afterCommit:[] as Array<()=>Promise<unknown>>,rollback:[]};
    const result=await action(context);
    if(result.accepted) for(const deliver of context.afterCommit) await deliver();
    return result;
  });
}
