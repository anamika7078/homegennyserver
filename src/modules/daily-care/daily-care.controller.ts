import {
  Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { AuthUser } from '../../common/guards/branch-scope.util';
import { sendStoredFile } from '../../common/storage/send-file.util';
import { CarePlanService } from './care-plan.service';
import { CookService } from './cook.service';
import { InstructionsService } from './instructions.service';
import { CareFilesService } from './care-files.service';
import { ClientUpdatesService } from './client-updates.service';
import { MenuCatalogService } from './menu-catalog.service';
import { CheckinsService } from './checkins.service';

type Req = { user: AuthUser };
const ALL = [UserRole.CLIENT, UserRole.STAFF, UserRole.RM, UserRole.BM, UserRole.ADMIN];

/**
 * One placement's daily care — shared by the client app, the staff app and the
 * RM web. Who may do what is decided per call (CareAccessService): the client
 * writes the plan, menu and instructions; the staff ticks, logs and answers;
 * the RM reads everything in their scope.
 */
@ApiTags('Daily Care')
@ApiBearerAuth()
@Roles(...ALL)
@Controller({ path: 'care/placements/:pid', version: '1' })
export class PlacementCareController {
  constructor(
    private readonly care: CarePlanService,
    private readonly cook: CookService,
    private readonly instructions: InstructionsService,
    private readonly updates: ClientUpdatesService,
  ) {}

  @Get('plan')
  @ApiOperation({ summary: 'Active care plan + version history + staff_acknowledged_at (caretaker placements)' })
  getPlan(@Req() req: Req, @Param('pid') pid: string) {
    return this.care.getPlan(req.user, pid);
  }

  @Put('plan')
  @ApiOperation({ summary: 'Client: write the care plan. Every save is a new version; the staff is notified with what changed.' })
  @ApiBody({
    schema: {
      type: 'object',
      example: {
        patient: { name: 'Ramesh Kumar', age: 78, conditions: ['Diabetes'], allergies: ['Penicillin'], mobility: 'ASSISTED', doctor_name: 'Dr Mehta', doctor_phone: '9811111111' },
        medications: [{ name: 'Metformin', dose: '500', unit: 'mg', route: 'ORAL', times: ['08:00', '20:00'], food_relation: 'AFTER', prescription_file_id: null }],
        vitals: [{ type: 'BP', times: ['08:00'] }, { type: 'SUGAR_FASTING', times: ['07:30'], min: 70, max: 130 }],
        activities: [{ type: 'WALK', title: 'Evening walk', times: ['17:30'], duration_min: 20 }],
        diet_notes: 'Low salt, no sugar', dos: 'Help him stand slowly', donts: 'No sweets',
      },
    },
  })
  savePlan(@Req() req: Req, @Param('pid') pid: string, @Body() body: Record<string, unknown>) {
    return this.care.savePlan(req.user, pid, body);
  }

  @Get('day')
  @ApiOperation({ summary: "One day's checklist + summary + daily report (default today, IST)" })
  @ApiQuery({ name: 'date', required: false, example: '2026-10-12' })
  day(@Req() req: Req, @Param('pid') pid: string, @Query('date') date?: string) {
    return this.care.getDay(req.user, pid, date);
  }

  @Get('history')
  @ApiOperation({ summary: 'Per-day adherence and every vital reading (default last 7 days, max 92)' })
  history(@Req() req: Req, @Param('pid') pid: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.care.history(req.user, pid, from, to);
  }

  @Get('food-profile')
  @ApiOperation({ summary: "The household's food profile, read through a cook placement" })
  foodProfile(@Req() req: Req, @Param('pid') pid: string) {
    return this.cook.getProfileForPlacement(req.user, pid);
  }

  @Get('menu')
  @ApiOperation({ summary: "A week's menu (Mon–Sun) with health warnings" })
  @ApiQuery({ name: 'week', required: false, description: '2026-W42 or any date in the week; default this week' })
  menu(@Req() req: Req, @Param('pid') pid: string, @Query('week') week?: string) {
    return this.cook.getMenu(req.user, pid, week);
  }

  @Put('menu')
  @ApiOperation({ summary: 'Client: set menu slots. items: [{ date, meal, dish_ids?: [], dishes?: ["Dal", {name, notes}], meal_time?: "08:30", special_instruction?, servings?, photo_file_ids?: [] }]; dish_ids and dishes both empty clears a slot.' })
  saveMenu(@Req() req: Req, @Param('pid') pid: string, @Body() body: Record<string, unknown>) {
    return this.cook.saveMenu(req.user, pid, body);
  }

  @Post('menu/copy-week')
  @ApiOperation({ summary: 'Client: "same as last week". { from_week, to_week, overwrite? } — weeks as 2026-W42 or any date in the week' })
  copyWeek(@Req() req: Req, @Param('pid') pid: string, @Body() body: Record<string, unknown>) {
    return this.cook.copyWeek(req.user, pid, body);
  }

  @Get('meals')
  @ApiOperation({ summary: 'What the cook made (default today) with ratings + 7/30-day averages' })
  meals(@Req() req: Req, @Param('pid') pid: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.cook.listMeals(req.user, pid, from, to);
  }

  @Get('instructions')
  @ApiOperation({ summary: 'Instructions on this placement, newest first' })
  @ApiQuery({ name: 'status', required: false, description: 'Comma list: SENT,ACKNOWLEDGED,DONE,REFUSED,CANCELLED' })
  listInstructions(@Req() req: Req, @Param('pid') pid: string, @Query('status') status?: string) {
    return this.instructions.list(req.user, pid, status);
  }

  @Post('instructions')
  @ApiOperation({ summary: 'Client: tell the staff something. { text?, voice_file_id?, kind: ONE_TIME|RECURRING, due_at?, recurrence?: { times[], days[] } }' })
  createInstruction(@Req() req: Req, @Param('pid') pid: string, @Body() body: Record<string, unknown>) {
    return this.instructions.create(req.user, pid, body);
  }

  @Get('report')
  @ApiOperation({ summary: 'Client/RM: monthly care report as a PDF' })
  @ApiQuery({ name: 'month', required: false, example: '2026-10' })
  async report(@Req() req: Req, @Param('pid') pid: string, @Res() res: Response, @Query('month') month?: string) {
    const { buffer, filename } = await this.updates.monthlyReport(req.user, pid, month);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(buffer);
  }
}

/** Photos, prescriptions, voice notes — upload first, then reference the id. */
@ApiTags('Daily Care')
@ApiBearerAuth()
@Roles(...ALL)
@Controller({ path: 'care-files', version: '1' })
export class CareFilesController {
  constructor(private readonly files: CareFilesService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload. kind: PHOTO (jpg/png/webp ≤5MB), PRESCRIPTION (client; +pdf ≤10MB), VOICE (mp3/m4a/aac/ogg/webm/wav ≤5MB)' })
  @ApiBody({ schema: { type: 'object', required: ['placement_id', 'kind', 'file'], properties: { placement_id: { type: 'string' }, kind: { type: 'string', enum: ['PHOTO', 'PRESCRIPTION', 'VOICE'] }, file: { type: 'string', format: 'binary' } } } })
  upload(@Req() req: Req, @Body() body: { placement_id?: string; kind?: string }, @UploadedFile() file?: Express.Multer.File) {
    return this.files.upload(req.user, String(body.placement_id ?? ''), String(body.kind ?? ''), file);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Stream a file — same access as its placement' })
  async get(@Req() req: Req, @Param('id') id: string, @Res() res: Response) {
    const { row, stream } = await this.files.read(req.user, id);
    sendStoredFile(res, stream, row.mimeType, 'inline', row.originalName ?? undefined);
  }
}

/** The client-only calls that aren't about one placement. */
@ApiTags('Client Mobile App', 'Daily Care')
@ApiBearerAuth()
@Roles(UserRole.CLIENT)
@Controller({ path: 'client', version: '1' })
export class ClientCareController {
  constructor(
    private readonly cook: CookService,
    private readonly instructions: InstructionsService,
    private readonly catalog: MenuCatalogService,
    private readonly checkins: CheckinsService,
  ) {}

  @Post('dishes')
  @ApiOperation({ summary: '"+ Add as my dish". { name, category, diet: VEG|EGG|NON_VEG, meals? }. Same name already on the list → that dish, existing: true.' })
  addDish(@Req() req: Req, @Body() body: Record<string, unknown>) {
    return this.catalog.addOwn(req.user.id, body);
  }

  @Get('dishes')
  @ApiOperation({ summary: 'My own dishes' })
  myDishes(@Req() req: Req) {
    return this.catalog.listOwn(req.user.id);
  }

  @Delete('dishes/:id')
  @ApiOperation({ summary: 'Remove one of my dishes from the dropdown (menus that use it keep the name)' })
  removeDish(@Req() req: Req, @Param('id') id: string) {
    return this.catalog.removeOwn(req.user.id, id);
  }

  @Get('menu-template')
  @ApiOperation({ summary: 'The weekly menu template' })
  getTemplate(@Req() req: Req) {
    return this.cook.getTemplate(req.user.id);
  }

  @Put('menu-template')
  @ApiOperation({ summary: 'Weekly template: { items: [{ dow: MON..SUN, meal, dish_ids?, dishes?, meal_time?, special_instruction?, servings? }], active? }. Fills empty slots from today on; never overwrites a slot you set.' })
  saveTemplate(@Req() req: Req, @Body() body: Record<string, unknown>) {
    return this.cook.saveTemplate(req.user.id, body);
  }

  @Put('home-location')
  @ApiOperation({ summary: 'Set my home on the map: { lat, lng }. Used to check staff check-ins are at the house.' })
  homeLocation(@Req() req: Req, @Body() body: Record<string, unknown>) {
    return this.checkins.setOwnHome(req.user.id, body);
  }

  @Get('food-profile')
  @ApiOperation({ summary: "This household's food profile + suggestions from repeated meal feedback" })
  getProfile(@Req() req: Req) {
    return this.cook.getProfileForClient(req.user.id);
  }

  @Put('food-profile')
  @ApiOperation({ summary: 'Write the food profile. Every cook working here is notified with what changed.' })
  @ApiBody({ schema: { type: 'object', example: { diet_type: 'VEG', allergies: ['Peanuts'], spice_level: 2, salt: 'LOW', oil: 'LOW', health_conditions: ['DIABETIC'], cuisines: ['North Indian'], dislikes: 'Karela', family_size: 4, notes: '', meal_times: { BREAKFAST: '08:30', LUNCH: '13:00', DINNER: '20:30' } } } })
  saveProfile(@Req() req: Req, @Body() body: Record<string, unknown>) {
    return this.cook.saveProfile(req.user.id, body);
  }

  @Post('menu/:id/approve')
  @ApiOperation({ summary: "Approve the cook's suggested menu item" })
  approve(@Req() req: Req, @Param('id') id: string) {
    return this.cook.decideSuggestion(req.user, id, true);
  }

  @Post('menu/:id/reject')
  @ApiOperation({ summary: "Decline the cook's suggestion (reason required)" })
  reject(@Req() req: Req, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.cook.decideSuggestion(req.user, id, false, body?.reason);
  }

  @Post('meals/:id/feedback')
  @ApiOperation({ summary: 'Rate a meal. { rating: 1-5, tags?: [PERFECT, TOO_SPICY, LESS_SPICY, TOO_SALTY, LESS_SALT, OILY, UNDERCOOKED, OVERCOOKED, COLD, SMALL_PORTION], comment? }' })
  feedback(@Req() req: Req, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.cook.feedback(req.user, id, body);
  }

  @Post('instructions/:id/cancel')
  @ApiOperation({ summary: 'Withdraw an instruction that is not done yet' })
  cancel(@Req() req: Req, @Param('id') id: string) {
    return this.instructions.cancel(req.user, id);
  }
}

/** The staff app: today's work, and everything the family sent. */
@ApiTags('Daily Care')
@ApiBearerAuth()
@Roles(UserRole.STAFF)
@Controller({ path: 'staff/care', version: '1' })
export class StaffCareController {
  constructor(
    private readonly care: CarePlanService,
    private readonly cook: CookService,
    private readonly instructions: InstructionsService,
    private readonly updates: ClientUpdatesService,
  ) {}

  @Get('today')
  @ApiOperation({ summary: "Caretaker: today's checklist and report for each active placement" })
  today(@Req() req: Req) {
    return this.care.staffToday(req.user);
  }

  @Post('tasks/:id/done')
  @ApiOperation({ summary: 'Tick a task. Vitals need value: BP {systolic, diastolic} or {value}. Optional notes, photo_file_ids[].' })
  done(@Req() req: Req, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.care.markDone(req.user, id, body);
  }

  @Post('tasks/:id/skip')
  @ApiOperation({ summary: 'Skip a task (reason required — the family sees it)' })
  skip(@Req() req: Req, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.care.skip(req.user, id, body);
  }

  @Put('daily-report')
  @ApiOperation({ summary: "Today's (or yesterday's) report. { placement_id, date?, meals[{meal, description, quantity}], fluid_intake_ml, sleep, mood, hygiene{}, notes, photo_file_ids[] }" })
  report(@Req() req: Req, @Body() body: Record<string, unknown>) {
    return this.care.saveReport(req.user, body);
  }

  @Get('cook/today')
  @ApiOperation({ summary: "Cook: today's menu per meal, the food profile, ratings — per active placement" })
  cookToday(@Req() req: Req) {
    return this.cook.cookToday(req.user);
  }

  @Post('cook/menu-suggestions')
  @ApiOperation({ summary: 'Switched off — only the family sets the menu (always 403).' })
  suggest() {
    return this.cook.suggestMenu();
  }

  @Post('cook/meals')
  @ApiOperation({ summary: 'Cook: log a meal. { placement_id, date?, meal, dishes: [{ name, spice_level?, photo_file_id? }], servings?, notes? }' })
  logMeal(@Req() req: Req, @Body() body: Record<string, unknown>) {
    return this.cook.logMeal(req.user, body);
  }

  @Get('instructions')
  @ApiOperation({ summary: 'Instructions sent to me (not cancelled), newest first' })
  myInstructions(@Req() req: Req, @Query('status') status?: string) {
    return this.instructions.listForStaff(req.user, status);
  }

  @Post('instructions/:id/ack')
  @ApiOperation({ summary: 'Acknowledge — the staff member has read the instruction' })
  ack(@Req() req: Req, @Param('id') id: string) {
    return this.instructions.acknowledge(req.user, id);
  }

  @Post('instructions/:id/done')
  @ApiOperation({ summary: 'Mark done (one-time instructions only)' })
  doneIns(@Req() req: Req, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.instructions.done(req.user, id, body);
  }

  @Post('instructions/:id/refuse')
  @ApiOperation({ summary: 'Refuse as outside the job — opens a Right-to-Refuse case for the RM. { reason }' })
  refuse(@Req() req: Req, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.instructions.refuse(req.user, id, body);
  }

  @Get('client-updates')
  @ApiOperation({ summary: 'Everything the family sent (care plan, food profile, menu, instructions, meal ratings), newest first, with what changed' })
  @ApiQuery({ name: 'placement_id', required: false })
  @ApiQuery({ name: 'unread', required: false, description: 'true = only not yet acknowledged' })
  feed(@Req() req: Req, @Query() q: { placement_id?: string; unread?: string }) {
    return this.updates.feed(req.user, q);
  }

  @Get('client-updates/unread-count')
  @ApiOperation({ summary: 'Badge count for the home screen card' })
  unread(@Req() req: Req) {
    return this.updates.unreadCount(req.user);
  }

  @Post('client-updates/:type/:id/ack')
  @ApiOperation({ summary: 'Mark as read. type: CARE_PLAN | FOOD_PROFILE | MENU | INSTRUCTION | MEAL_FEEDBACK' })
  ackUpdate(@Req() req: Req, @Param('type') type: string, @Param('id') id: string) {
    return this.updates.ack(req.user, type, id);
  }
}

/** RM/BM: the compliance board and refused instructions. */
@ApiTags('RM Operations', 'Daily Care')
@ApiBearerAuth()
@Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
@Controller({ path: 'rm/care', version: '1' })
export class RmCareController {
  constructor(
    private readonly updates: ClientUpdatesService,
    private readonly instructions: InstructionsService,
  ) {}

  @Get('compliance')
  @ApiOperation({ summary: 'One row per active care/cook placement: today, missed doses, vital alerts, rating, instructions — RED/AMBER/GREEN' })
  compliance(@Req() req: Req) {
    return this.updates.compliance(req.user);
  }

  @Get('instructions/refused')
  @ApiOperation({ summary: 'Refused instructions waiting for a decision, each with the placement scope of work' })
  refused(@Req() req: Req) {
    return this.instructions.refusedQueue(req.user);
  }

  @Post('instructions/:id/decide')
  @ApiOperation({ summary: '{ decision: UPHELD (staff was right) | OVERTURNED (part of the job), note }' })
  decide(@Req() req: Req, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.instructions.decide(req.user, id, body);
  }
}

/** The dish dropdown — search the list (and, for a client, their own dishes). */
@ApiTags('Daily Care')
@ApiBearerAuth()
@Roles(...ALL)
@Controller({ path: 'care/dishes', version: '1' })
export class DishesController {
  constructor(private readonly catalog: MenuCatalogService) {}

  @Get()
  @ApiOperation({ summary: 'Search dishes. A client gets only what their food-profile diet allows, their regions and the asked meal first. can_add=true → offer "+ Add as my dish".' })
  @ApiQuery({ name: 'q', required: false, description: 'Part of the name' })
  @ApiQuery({ name: 'meal', required: false, enum: ['BREAKFAST', 'LUNCH', 'SNACKS', 'DINNER'] })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'diet', required: false, enum: ['VEG', 'EGG', 'NON_VEG'] })
  @ApiQuery({ name: 'region', required: false })
  @ApiQuery({ name: 'limit', required: false, description: 'Default 50, max 100' })
  search(@Req() req: Req, @Query() q: { q?: string; meal?: string; category?: string; diet?: string; region?: string; limit?: string }) {
    return this.catalog.search(req.user, q);
  }
}

/** Where staff checked in/out, on a map. */
@ApiTags('RM Operations', 'Daily Care')
@ApiBearerAuth()
@Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
@Controller({ path: 'rm', version: '1' })
export class RmCheckinsController {
  constructor(private readonly checkins: CheckinsService) {}

  @Get('checkins')
  @ApiOperation({ summary: 'Check-ins/outs of one day (IST, default today) with distance from the client home; far = over 300 m' })
  @ApiQuery({ name: 'date', required: false, example: '2026-10-14' })
  @ApiQuery({ name: 'branch_id', required: false, description: 'Admin only' })
  list(@Req() req: Req, @Query() q: { date?: string; branch_id?: string }) {
    return this.checkins.list(req.user, q);
  }

  @Patch('clients/:id/home-location')
  @ApiOperation({ summary: 'Set the home of a client on the map: { lat, lng }' })
  setHome(@Req() req: Req, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.checkins.setClientHome(req.user, id, body);
  }
}
