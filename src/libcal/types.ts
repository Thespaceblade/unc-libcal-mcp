export interface AvailabilitySlot {
  start: string;
  end: string;
  itemId: number;
  checksum: string;
  className?: string;
  available: boolean;
}

export interface PendingBooking {
  id: number;
  eid: number;
  seat_id: number;
  gid: number;
  lid: number;
  start: string;
  end: string;
  checksum: string;
}

export interface BookingResult {
  success: boolean;
  spaceName: string;
  itemId: number;
  start: string;
  end: string;
  location: string;
  confirmationUrl?: string;
  message: string;
}

export interface UserConfig {
  defaultCategory?: string;
  email?: string;
  bookingPurpose?: string;
  preferSameDay?: boolean;
  minLeadMinutes?: number;
  searchHorizonDays?: number;
}
