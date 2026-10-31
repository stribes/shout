export interface Shout {
	id: string;
	content: string;
	createdAt: number;
}

export interface Archive {
	id: string;
	number: number;
	count: number;
	createdAt: number;
}

export type ClientMessage =
	| {
			type: 'shout';
			content: string;
	  }
	| {
			type: 'archive';
			id: string;
	  };

export type ServerMessage =
	| {
			type: 'history';
			shouts: Shout[];
			archives: Archive[];
	  }
	| {
			type: 'shout';
			shout: Shout;
	  }
	| {
			type: 'rollover';
			archive: Archive;
	  }
	| {
			type: 'archive';
			archive: Archive;
			shouts: Shout[];
	  }
	| {
			type: 'error';
			message: string;
	  };
