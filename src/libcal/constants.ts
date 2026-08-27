export const BASE_URL = "https://calendar.lib.unc.edu";

export interface SpaceCategory {
  id: string;
  name: string;
  lid: number;
  gid: number;
  path: string;
}

/** UNC LibCal space categories we reverse-engineered. */
export const SPACE_CATEGORIES: Record<string, SpaceCategory> = {
  "davis-cubes": {
    id: "davis-cubes",
    name: "Davis Collaboration Cubes",
    lid: 355,
    gid: 7694,
    path: "/reserve/davis-cubes",
  },
  "davis-study-rooms": {
    id: "davis-study-rooms",
    name: "Davis Group Study Rooms",
    lid: 355,
    gid: 750,
    path: "/reserve/davis-study-rooms",
  },
  "davis-computers": {
    id: "davis-computers",
    name: "Davis Data Services Lab Computers",
    lid: 355,
    gid: 7699,
    path: "/reserve/data-services-computers",
  },
};

export const DEFAULT_CATEGORY = "davis-cubes";
