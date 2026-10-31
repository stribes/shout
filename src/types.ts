
export interface Shout {
  id: string;
  content: string;
  createdAt: number;
}

export type ClientMessage = {
  type: "shout";
  content: string;
};

export type ServerMessage =
  | {
      type: "history";
      shouts: Shout[];
    }
  | {
      type: "shout";
      shout: Shout;
    }
  | {
      type: "error";
      message: string;
    };
