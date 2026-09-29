import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody, ApiQuery } from '@nestjs/swagger';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { TrainingQuizService, QuizQuestionInput } from './training-quiz.service';

interface AuthedRequest { user: { id: string; role: string; phone: string; branchId?: string | null } }

const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    question_text: { type: 'string' },
    type: { type: 'string', enum: ['MCQ', 'TEXT'], default: 'MCQ' },
    options: { type: 'array', items: { type: 'string' }, description: 'MCQ only' },
    correct_option: { type: 'number', description: 'MCQ only — index into options' },
    points: { type: 'number', default: 1, description: 'Marks for this question' },
  },
};

type QuizBody = { title: string; pass_marks?: number | null; questions: QuizQuestionInput[] };

// Route order matters: Express matches in REGISTRATION order, not by
// specificity, so every literal route (mine, submissions, attempts/...) is
// declared before the `:id` wildcard routes at the bottom — otherwise
// GET /quizzes/mine would bind :id="mine" and hit a TRAINER-only handler.
@ApiTags('Training')
@ApiBearerAuth()
@Controller({ path: 'training/quizzes', version: '1' })
export class TrainingQuizController {
  constructor(private readonly service: TrainingQuizService) {}

  @Post()
  @Roles(UserRole.TRAINER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Create a quiz for a batch (MCQ and/or answer-type questions, marks per question)' })
  @ApiBody({ schema: { type: 'object', required: ['batch_id', 'title', 'questions'], properties: {
    batch_id: { type: 'string' },
    title: { type: 'string', example: 'Day 3 recap' },
    pass_marks: { type: 'number', description: 'Marks needed to pass. Omit for 60% of the total.' },
    questions: { type: 'array', items: QUESTION_SCHEMA },
  } } })
  create(@Body() body: QuizBody & { batch_id: string }, @Req() req: AuthedRequest) {
    return this.service.createQuiz({ ...body, batchId: body.batch_id, createdBy: req.user.id });
  }

  @Get()
  @Roles(UserRole.TRAINER, UserRole.RM, UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'List quizzes for a batch' })
  list(@Query('batch_id') batchId: string) {
    if (!batchId) throw new BadRequestException('batch_id is required');
    return this.service.listQuizzes(batchId);
  }

  // ── Literal routes ───────────────────────────────────────────────────────

  @Get('mine')
  @Roles(UserRole.STAFF)
  @ApiOperation({ summary: 'My quizzes with their state (LOCKED/SCHEDULED/AVAILABLE/IN_PROGRESS/UNDER_REVIEW/PASSED/FAILED)' })
  async listMine(@Req() req: AuthedRequest) {
    const staffId = await this.service.resolveStaffApplicantId(req.user.id, req.user.phone);
    return this.service.staffQuizzes(staffId);
  }

  @Get('submissions')
  @Roles(UserRole.TRAINER, UserRole.BM, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Assessment tab: one row per (quiz, enrolled staff), including staff who have not attempted',
    description: 'state is NOT_ATTEMPTED | SCHEDULED | IN_PROGRESS | PENDING_REVIEW | PASSED | FAILED. TRAINER sees only their own batches.',
  })
  @ApiQuery({ name: 'batch_id', required: false })
  @ApiQuery({ name: 'quiz_id', required: false })
  @ApiQuery({ name: 'state', required: false })
  submissions(
    @Req() req: AuthedRequest,
    @Query('batch_id') batchId?: string,
    @Query('quiz_id') quizId?: string,
    @Query('state') state?: string,
  ) {
    return this.service.listSubmissions(req.user, { batchId, quizId, state });
  }

  @Get('staff/:staffId/summary')
  @Roles(UserRole.RM, UserRole.BM, UserRole.TRAINER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Read-only quiz status for one staff member (RM staff detail)' })
  staffSummary(@Param('staffId') staffId: string) {
    return this.service.staffQuizzes(staffId);
  }

  @Get('attempts/:attemptId')
  @Roles(UserRole.TRAINER, UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'One attempt in full for review — every question, the answer key, and attempt history' })
  getAttempt(@Param('attemptId') attemptId: string) {
    return this.service.getAttemptDetail(attemptId);
  }

  @Get('attempts/:attemptId/questions')
  @Roles(UserRole.STAFF)
  @ApiOperation({ summary: 'Questions for my in-progress attempt — no answer key' })
  async getQuestions(@Param('attemptId') attemptId: string, @Req() req: AuthedRequest) {
    const staffId = await this.service.resolveStaffApplicantId(req.user.id, req.user.phone);
    return this.service.getQuestionsForAttempt(attemptId, staffId);
  }

  @Get('attempts/:attemptId/result')
  @Roles(UserRole.STAFF)
  @ApiOperation({ summary: 'My result: marks, pass/fail, and ✔/✘ per question — never the correct answer' })
  async getResult(@Param('attemptId') attemptId: string, @Req() req: AuthedRequest) {
    const staffId = await this.service.resolveStaffApplicantId(req.user.id, req.user.phone);
    return this.service.getResultForStaff(attemptId, staffId);
  }

  @Post('attempts/:attemptId/review')
  @Roles(UserRole.TRAINER, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Mark answers ✔/✘ and finalize',
    description: '✔ gives the question its full marks, ✘ gives 0. MCQ marks can be overridden. Every question must be marked to finalize.',
  })
  @ApiBody({ schema: { type: 'object', required: ['marks'], properties: {
    marks: { type: 'array', items: { type: 'object', properties: {
      question_id: { type: 'string' }, correct: { type: 'boolean' },
    } } },
  } } })
  review(
    @Param('attemptId') attemptId: string,
    @Body() body: { marks: { question_id: string; correct: boolean }[] },
    @Req() req: AuthedRequest,
  ) {
    return this.service.reviewAttempt(attemptId, req.user.id, body?.marks ?? []);
  }

  @Post('attempts/:attemptId/submit')
  @Roles(UserRole.STAFF)
  @ApiOperation({ summary: 'Submit my answers — MCQ marked now, answer-type waits on the trainer' })
  @ApiBody({ schema: { type: 'object', required: ['answers'], properties: {
    answers: { type: 'array', items: { type: 'object', properties: {
      question_id: { type: 'string' }, selected_option: { type: 'number' }, answer_text: { type: 'string' },
    } } },
  } } })
  async submit(
    @Param('attemptId') attemptId: string,
    @Body() body: { answers: { question_id: string; selected_option?: number; answer_text?: string }[] },
    @Req() req: AuthedRequest,
  ) {
    const staffId = await this.service.resolveStaffApplicantId(req.user.id, req.user.phone);
    return this.service.submitAttempt(attemptId, staffId, body?.answers ?? []);
  }

  // ── :id wildcard routes — keep below every literal route ─────────────────

  @Get(':id')
  @Roles(UserRole.TRAINER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Full quiz including the answer key — trainer/admin only' })
  getOne(@Param('id') id: string) {
    return this.service.getQuiz(id);
  }

  @Patch(':id')
  @Roles(UserRole.TRAINER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Edit a quiz — only while nobody has attempted it' })
  @ApiBody({ schema: { type: 'object', required: ['title', 'questions'], properties: {
    title: { type: 'string' }, pass_marks: { type: 'number' }, questions: { type: 'array', items: QUESTION_SCHEMA },
  } } })
  update(@Param('id') id: string, @Body() body: QuizBody) {
    return this.service.updateQuiz(id, body);
  }

  @Post(':id/start')
  @Roles(UserRole.STAFF)
  @ApiOperation({ summary: 'Start (or resume) my open attempt — returns the attempt with its questions' })
  async start(@Param('id') id: string, @Req() req: AuthedRequest) {
    const staffId = await this.service.resolveStaffApplicantId(req.user.id, req.user.phone);
    return this.service.startAttempt(id, staffId);
  }

  @Post(':id/reschedule')
  @Roles(UserRole.TRAINER, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Reschedule this quiz for one staff member',
    description: 'For a failed or not-attempted staff (or to move an existing schedule). Sends the staff an in-app notification.',
  })
  @ApiBody({ schema: { type: 'object', required: ['staff_id', 'available_at'], properties: {
    staff_id: { type: 'string' },
    available_at: { type: 'string', format: 'date-time', example: '2026-10-05T10:00:00+05:30' },
    note: { type: 'string' },
  } } })
  reschedule(
    @Param('id') id: string,
    @Body() body: { staff_id: string; available_at: string; note?: string },
    @Req() req: AuthedRequest,
  ) {
    if (!body?.staff_id) throw new BadRequestException('staff_id is required');
    return this.service.reschedule(id, body.staff_id, body.available_at, body.note, req.user.id);
  }

  @Delete(':id')
  @Roles(UserRole.TRAINER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete a quiz (and every attempt at it)' })
  deleteOne(@Param('id') id: string) {
    return this.service.deleteQuiz(id);
  }
}
