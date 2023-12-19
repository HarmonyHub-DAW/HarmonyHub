import Note from "@models/note";
import Pattern from "@models/pattern";
import Project from "@models/project";
import { Socket } from "socket.io-client";

export interface ServerToClientEvents {
    'hh:data': (args: { id: string, data: ArrayBuffer }, callback: (res?: { data: ArrayBuffer }) => void) => void;
    'hh:user-disconnected': (args: { id: string }) => void;
}

export interface ClientToServerEvents {
    'hh:create-session': (args: null, callback: (ack: { room: string }) => void) => void;
    'hh:join-session': (args: { room: string }, callback: (ack: { success: boolean }) => void) => void;
    'hh:broadcast': (args: { data: ArrayBuffer }, callback: (res: { id: string, data?: ArrayBuffer }[]) => void) => void;
    'hh:request': (args: { data: ArrayBuffer }, callback: (res: { data: ArrayBuffer }) => void) => void;
}

export interface ClientToClientEvents {
    'hh:request-project': (args: null) => Project;
    'hh:user-joined': (args: { name: string }) => void;
    'hh:note-update': (args: { patternId: string, id: string, note: Note}) => void; 
    'hh:note-deleted': (args: { patternId: string, id: string}) => void;
    'hh:pattern-created': (args: { id: string, pattern: Pattern }) => void;
    'hh:mouse-position': (args: { context: string, x: number, y: number }) => void;
    'hh:username-update': (args: { name: string }) => void;
    'hh:request-username': (args: null) => string;
}

export type TypedSocket = Prettify<Socket<ServerToClientEvents, ClientToServerEvents>>;
