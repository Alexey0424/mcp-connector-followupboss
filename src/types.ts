export interface FubCall {
  id: number;
  userId: number | null;
  userName: string | null;
  personId: number | null;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  isIncoming: boolean;
  duration: number | null;      // talk time, seconds
  ringDuration: number | null;
  outcome: string | null;
  startedAt: string | null;     // ISO
  created: string | null;       // ISO
  recordingUrl: string | null;
  note: string | null;          // Part C AI summary lives here
}

export interface FubPerson {
  id: number;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  stage: string | null;
  assignedUserId: number | null;
  assignedTo: string | null;
  emails?: { value: string }[];
  phones?: { value: string }[];
}

export interface FubUser {
  id: number;
  name: string | null;
  email: string | null;
  role?: string | null;
}

export interface FubNote {
  id: number;
  personId: number | null;
  createdById: number | null;
  createdBy: string | null;
  created: string | null;   // ISO
  subject: string | null;
  body: string | null;
  type: string | null;
}

export interface FubText {
  id: number;
  personId: number | null;
  userId: number | null;     // the agent — used to attribute the text to a closer
  userName: string | null;
  created: string | null;    // ISO, e.g. "2026-07-06T18:19:11Z"
  isIncoming: boolean;
  message: string | null;
  fromNumber: string | null;
  toNumber: string | null;
}

export interface Period {
  createdAfter: string;             // ISO Z
  createdBefore?: string;           // ISO Z
}
