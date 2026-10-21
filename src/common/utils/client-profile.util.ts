import { BadRequestException } from '@nestjs/common';

/**
 * A client profile edit, checked — shared by PATCH /client/profile (the
 * client) and PATCH /rm/client-leads/:id (the RM on a call). Every field is
 * optional; blank means "leave as is".
 */
export function parseClientProfileBody(body: Record<string, unknown>) {
  const str = (v: unknown, max: number, field: string) => {
    if (v === undefined || v === null) return undefined;
    const t = String(v).trim();
    if (!t) return undefined;
    if (t.length > max) throw new BadRequestException(`${field} is too long (max ${max}).`);
    return t;
  };
  // `name` is what the app's profile screen already sends.
  const name = str(body.full_name ?? body.name, 200, 'full_name');
  if (name !== undefined && name.length < 2) throw new BadRequestException('full_name is too short.');
  const address = str(body.address, 2000, 'address');
  if (address !== undefined && address.length < 5) throw new BadRequestException('address is too short.');
  const pincode = str(body.pincode, 20, 'pincode');
  if (pincode !== undefined && !/^\d{6}$/.test(pincode)) throw new BadRequestException('pincode must be 6 digits.');
  const pan = str(body.pan_card, 20, 'pan_card')?.toUpperCase();
  if (pan !== undefined && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) throw new BadRequestException('pan_card is not a valid PAN.');
  const gstn = str(body.gstn, 20, 'gstn')?.toUpperCase();
  if (gstn !== undefined && !/^[0-9A-Z]{15}$/.test(gstn)) throw new BadRequestException('gstn must be 15 characters.');
  const email = str(body.email, 200, 'email');
  if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('email is not valid.');
  const lat = body.lat === undefined || body.lat === null || body.lat === '' ? undefined : Number(body.lat);
  const lng = body.lng === undefined || body.lng === null || body.lng === '' ? undefined : Number(body.lng);
  if ((lat === undefined) !== (lng === undefined)) throw new BadRequestException('Send lat and lng together.');
  if (lat !== undefined && (!Number.isFinite(lat) || !Number.isFinite(lng!) || Math.abs(lat) > 90 || Math.abs(lng!) > 180)) {
    throw new BadRequestException('lat/lng are not a real location.');
  }
  return {
    name,
    address,
    city: str(body.city, 100, 'city'),
    state: str(body.state, 100, 'state'),
    pincode,
    pan_card: pan,
    gstn,
    email,
    lat,
    lng,
  };
}
