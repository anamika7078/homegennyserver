import { Injectable, Logger, BadRequestException, NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { mapSeriesToShort } from '../../common/mappers/staff.mapper';
import { REQUIRED_VIDEO_PROMPTS } from '../pipeline/pipeline-fsm.service';
import { TrainingMaterialsService } from './training-materials.service';
import { resolveStaffApplicantId } from './staff-identity.util';

/** Pass threshold when a quiz has no explicit pass_marks. */
const DEFAULT_PASS_RATIO = 0.6;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface QuizQuestionInput {
  question_text: string;
  type?: 'MCQ' | 'TEXT';
  options?: string[];
  correct_option?: number;
  points?: number;
}

export interface QuizInput {
  title: string;
  pass_marks?: number | null;
  questions: QuizQuestionInput[];
}

export interface ScopeUser { id: string; role: string; branchId?: string | null }

/**
 * What the staff app shows for one quiz. Derived from the latest attempt and
 * the batch's quiz date — never stored.
 *   LOCKED       no attempt yet, batch quiz_date is still in the future
 *   SCHEDULED    trainer rescheduled it; opens at opensAt
 *   AVAILABLE    can be started now
 *   IN_PROGRESS  started, not submitted
 *   UNDER_REVIEW submitted, trainer still has answer-type questions to mark
 *   PASSED / FAILED  graded; FAILED stays until the trainer reschedules
 */
export type StaffQuizState = 'LOCKED' | 'SCHEDULED' | 'AVAILABLE' | 'IN_PROGRESS' | 'UNDER_REVIEW' | 'PASSED' | 'FAILED';

/** Trainer-side view of one (quiz, enrolled staff) pair. */
export type SubmissionState = 'NOT_ATTEMPTED' | 'SCHEDULED' | 'IN_PROGRESS' | 'PENDING_REVIEW' | 'PASSED' | 'FAILED';

/**
 * Batch-scoped quizzes. MCQ answers are marked at submit; answer-type (TEXT)
 * answers wait for the trainer, who marks every answer ✔/✘ (and may override
 * an MCQ mark). ✔ earns the question's full points, ✘ earns 0. A failed quiz
 * never blocks the pipeline (only video-cert gates S3→S4) and is never retried
 * automatically — the trainer reschedules it, which opens a new attempt row so
 * the history of earlier attempts stays intact.
 */
@Injectable()
export class TrainingQuizService {
  private readonly logger = new Logger(TrainingQuizService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly materials: TrainingMaterialsService,
  ) {}

  resolveStaffApplicantId(userId: string, phone: string): Promise<string> {
    return resolveStaffApplicantId(this.prisma, userId, phone);
  }

  // ── Trainer: author / edit a quiz ───────────────────────────────────────

  async createQuiz(params: QuizInput & { batchId: string; createdBy: string }) {
    await this.assertBatchExists(params.batchId);
    this.validateQuiz(params);

    const [quiz] = await this.prisma.$queryRawUnsafe<any[]>(
      `INSERT INTO training_quizzes (batch_id, title, created_by, pass_marks)
       VALUES ($1::uuid, $2, $3::uuid, $4) RETURNING id`,
      params.batchId, params.title.trim(), params.createdBy, params.pass_marks ?? null,
    );
    await this.insertQuestions(this.prisma, quiz.id, params.questions);
    return this.getQuiz(quiz.id);
  }

  /** Only while nobody has an attempt — after that, fix a wrong answer key through review instead. */
  async updateQuiz(quizId: string, input: QuizInput) {
    const quiz = await this.findQuiz(quizId);
    const [{ cnt }] = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS cnt FROM quiz_attempts WHERE quiz_id = $1::uuid`, quizId,
    );
    if (cnt > 0) {
      throw new ConflictException(
        'This quiz already has attempts, so it can no longer be edited. Fix a wrong answer key by overriding the mark while reviewing an attempt.',
      );
    }
    this.validateQuiz(input);

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM quiz_questions WHERE quiz_id = $1::uuid`, quizId);
      await tx.$executeRawUnsafe(
        `UPDATE training_quizzes SET title = $1, pass_marks = $2, updated_at = now() WHERE id = $3::uuid`,
        input.title.trim(), input.pass_marks ?? null, quizId,
      );
      await this.insertQuestions(tx as any, quiz.id, input.questions);
    });
    return this.getQuiz(quizId);
  }

  /** Full quiz including the answer key — trainer/admin only. */
  async getQuiz(quizId: string) {
    const quiz = await this.findQuiz(quizId);
    const questions = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, question_text, type, options, correct_option, order_index, points
       FROM quiz_questions WHERE quiz_id = $1::uuid ORDER BY order_index ASC`,
      quizId,
    );
    const [{ cnt }] = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS cnt FROM quiz_attempts WHERE quiz_id = $1::uuid`, quizId,
    );
    const totalPoints = questions.reduce((s, q) => s + q.points, 0);
    return {
      ...this.mapQuiz(quiz),
      totalPoints,
      passMarks: this.effectivePassMarks(quiz.pass_marks, totalPoints),
      passMarksIsDefault: quiz.pass_marks == null,
      attemptCount: cnt,
      editable: cnt === 0,
      questions: questions.map((q) => this.mapQuestion(q, true)),
    };
  }

  async listQuizzes(batchId: string) {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT q.id, q.batch_id, q.title, q.pass_marks, q.created_by, q.created_at,
              (SELECT COUNT(*)::int FROM quiz_questions WHERE quiz_id = q.id) AS question_count,
              (SELECT COALESCE(SUM(points), 0)::int FROM quiz_questions WHERE quiz_id = q.id) AS total_points,
              (SELECT COUNT(*)::int FROM quiz_attempts WHERE quiz_id = q.id) AS attempt_count,
              (SELECT COUNT(*)::int FROM quiz_attempts WHERE quiz_id = q.id AND status = 'SUBMITTED') AS pending_grading
       FROM training_quizzes q WHERE q.batch_id = $1::uuid ORDER BY q.created_at ASC`,
      batchId,
    );
    return rows.map((r) => ({
      ...this.mapQuiz(r),
      questionCount: r.question_count,
      totalPoints: r.total_points,
      passMarks: this.effectivePassMarks(r.pass_marks, r.total_points),
      attemptCount: r.attempt_count,
      pendingGrading: r.pending_grading,
      editable: r.attempt_count === 0,
    }));
  }

  async deleteQuiz(quizId: string): Promise<void> {
    await this.findQuiz(quizId);
    await this.prisma.$executeRawUnsafe(`DELETE FROM training_quizzes WHERE id = $1::uuid`, quizId);
  }

  // ── Trainer: submissions, review, reschedule ────────────────────────────

  /**
   * One row per (quiz, enrolled staff) across the batches this user can see —
   * including staff who haven't attempted yet, so they can be rescheduled too.
   */
  async listSubmissions(user: ScopeUser, filter: { batchId?: string; quizId?: string; state?: string }) {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.batchId) { params.push(filter.batchId); where.push(`q.batch_id = $${params.length}::uuid`); }
    if (filter.quizId) { params.push(filter.quizId); where.push(`q.id = $${params.length}::uuid`); }
    where.push(...this.scopeClauses(user));

    const pairs = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT q.id AS quiz_id, q.title AS quiz_title, q.pass_marks,
              b.id AS batch_id, b.batch_code,
              sa.id AS staff_id, sa.full_name, sa.staff_code, sa.series, sa.pipeline_stage,
              (SELECT COALESCE(SUM(points), 0)::int FROM quiz_questions WHERE quiz_id = q.id) AS total_points
       FROM training_quizzes q
       JOIN training_batches b ON b.id = q.batch_id
       JOIN batch_enrollments be ON be.batch_id = q.batch_id
       JOIN staff_applicants sa ON sa.id = be.staff_id AND sa.deleted_at IS NULL
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY q.created_at DESC, sa.full_name ASC`,
      ...params,
    );
    if (!pairs.length) return { counts: this.emptyCounts(), rows: [] };

    const history = await this.attemptHistory([...new Set(pairs.map((p) => p.quiz_id))]);
    const rows = pairs.map((p) => {
      const attempts = history.get(`${p.quiz_id}:${p.staff_id}`) ?? [];
      const latest = attempts[attempts.length - 1];
      const passMarks = this.effectivePassMarks(p.pass_marks, p.total_points);
      return {
        quizId: p.quiz_id,
        quizTitle: p.quiz_title,
        batchId: p.batch_id,
        batchCode: p.batch_code,
        staffId: p.staff_id,
        staffName: p.full_name,
        staffCode: p.staff_code,
        series: mapSeriesToShort(p.series),
        pipelineStage: p.pipeline_stage,
        state: this.submissionState(latest),
        latestAttemptId: latest?.id ?? null,
        score: latest?.status === 'GRADED' ? latest.auto_score : null,
        maxScore: p.total_points,
        passMarks,
        submittedAt: latest?.submitted_at ?? null,
        availableAt: latest?.status === 'SCHEDULED' ? latest.available_at : null,
        attempts: attempts.map((a, i) => this.mapHistoryEntry(a, i)),
      };
    });

    const counts = this.emptyCounts();
    for (const r of rows) counts[r.state as SubmissionState]++;
    const filtered = filter.state ? rows.filter((r) => r.state === filter.state) : rows;
    return { counts, rows: filtered };
  }

  /** How many submissions are waiting on this trainer — the dashboard counter. */
  async countPendingReview(user: ScopeUser): Promise<number> {
    const where = this.scopeClauses(user);
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS cnt FROM quiz_attempts a
       JOIN training_quizzes q ON q.id = a.quiz_id
       JOIN training_batches b ON b.id = q.batch_id
       WHERE a.status = 'SUBMITTED' ${where.length ? 'AND ' + where.join(' AND ') : ''}`,
    );
    return rows[0]?.cnt ?? 0;
  }

  /** One attempt in full for review — every question, answered or not, with the answer key. */
  async getAttemptDetail(attemptId: string) {
    const attempt = await this.findAttempt(attemptId);
    const [quiz] = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT q.title, q.pass_marks, tb.batch_code FROM training_quizzes q
       JOIN training_batches tb ON tb.id = q.batch_id WHERE q.id = $1::uuid`,
      attempt.quiz_id,
    );
    const [staff] = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT full_name, staff_code FROM staff_applicants WHERE id = $1::uuid`, attempt.staff_id,
    );
    const questions = await this.questionsWithAnswers(attemptId, attempt.quiz_id);
    const history = (await this.attemptHistory([attempt.quiz_id])).get(`${attempt.quiz_id}:${attempt.staff_id}`) ?? [];
    const index = history.findIndex((a) => a.id === attemptId);
    const isLatest = index === history.length - 1;
    const totalPoints = questions.reduce((s, q) => s + q.points, 0);

    return {
      ...this.mapAttempt(attempt),
      quizTitle: quiz?.title,
      batchCode: quiz?.batch_code,
      staffName: staff?.full_name,
      staffCode: staff?.staff_code,
      attemptNumber: index + 1,
      totalPoints,
      passMarks: this.effectivePassMarks(quiz?.pass_marks, totalPoints),
      // A graded attempt stays re-reviewable only until a newer attempt exists.
      reviewable: attempt.status === 'SUBMITTED' || (attempt.status === 'GRADED' && isLatest),
      answers: questions.map((q) => ({
        questionId: q.id,
        questionText: q.question_text,
        type: q.type,
        options: q.options,
        correctOption: q.correct_option,
        points: q.points,
        selectedOption: q.selected_option,
        answerText: q.answer_text,
        answered: q.answer_id != null && (q.selected_option != null || !!q.answer_text?.trim()),
        isCorrect: q.is_correct,
        pointsAwarded: q.points_awarded,
      })),
      history: history.map((a, i) => this.mapHistoryEntry(a, i)),
    };
  }

  /**
   * Trainer marks answers ✔/✘. ✔ = the question's full points, ✘ = 0. Marks
   * not sent keep what they had (MCQ was marked at submit). Every question
   * must end up marked; then the attempt is GRADED against the pass marks.
   */
  async reviewAttempt(attemptId: string, reviewerId: string, marks: { question_id: string; correct: boolean }[]) {
    const attempt = await this.findAttempt(attemptId);
    const detail = await this.getAttemptDetail(attemptId);
    if (!detail.reviewable) {
      throw new ConflictException(
        attempt.status === 'GRADED'
          ? 'A newer attempt exists for this staff — only the latest attempt can be re-reviewed'
          : `Attempt is ${attempt.status} — nothing to review yet`,
      );
    }

    const byId = new Map(detail.answers.map((a) => [a.questionId, a]));
    for (const m of marks ?? []) {
      const q = byId.get(m.question_id);
      if (!q) throw new BadRequestException(`Question ${m.question_id} is not part of this quiz`);
      if (typeof m.correct !== 'boolean') throw new BadRequestException(`correct must be true or false for ${m.question_id}`);
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO quiz_answers (attempt_id, question_id, is_correct, points_awarded)
         VALUES ($1::uuid, $2::uuid, $3, $4)
         ON CONFLICT (attempt_id, question_id) DO UPDATE SET is_correct = $3, points_awarded = $4`,
        attemptId, m.question_id, m.correct, m.correct ? q.points : 0,
      );
    }

    const after = await this.questionsWithAnswers(attemptId, attempt.quiz_id);
    const unmarked = after.filter((q) => q.is_correct == null);
    if (unmarked.length) {
      throw new BadRequestException(`${unmarked.length} question(s) still need a ✔/✘ mark before this can be finalized`);
    }

    const score = after.reduce((s, q) => s + (q.points_awarded ?? 0), 0);
    const passed = score >= detail.passMarks;
    await this.prisma.$executeRawUnsafe(
      `UPDATE quiz_attempts
         SET status = 'GRADED', auto_score = $1, max_score = $2, passed = $3, graded_at = now(), graded_by = $4::uuid,
             submitted_at = COALESCE(submitted_at, now())
       WHERE id = $5::uuid`,
      score, detail.totalPoints, passed, reviewerId, attemptId,
    );
    await this.notifyResult(attempt.staff_id, { quizId: attempt.quiz_id, attemptId }, detail.quizTitle ?? 'Quiz', score, detail.totalPoints, passed);
    return this.getAttemptDetail(attemptId);
  }

  /**
   * Opens a new attempt for this staff at `availableAt`. Allowed when they
   * failed, never attempted, or already have a scheduled one (moves its date).
   */
  async reschedule(quizId: string, staffId: string, availableAtIso: string, note: string | undefined, byUserId: string) {
    const quiz = await this.findQuiz(quizId);
    await this.assertEnrolled(quizId, staffId);
    const availableAt = new Date(availableAtIso);
    if (!availableAtIso || isNaN(availableAt.getTime())) throw new BadRequestException('available_at must be a valid date-time');
    if (availableAt.getTime() < Date.now() - 5 * 60 * 1000) throw new BadRequestException('available_at is in the past');

    const history = (await this.attemptHistory([quizId])).get(`${quizId}:${staffId}`) ?? [];
    const latest = history[history.length - 1];
    const state = this.submissionState(latest);
    if (state === 'PASSED') throw new ConflictException('Staff already passed this quiz');
    if (state === 'IN_PROGRESS') throw new ConflictException('Staff is taking this quiz right now');
    if (state === 'PENDING_REVIEW') throw new ConflictException('Review the submitted attempt first');

    const noteVal = note?.trim() || null;
    if (state === 'SCHEDULED') {
      await this.prisma.$executeRawUnsafe(
        `UPDATE quiz_attempts SET available_at = $1, reschedule_note = $2, rescheduled_by = $3::uuid WHERE id = $4::uuid`,
        availableAt, noteVal, byUserId, latest.id,
      );
    } else {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO quiz_attempts (quiz_id, staff_id, status, available_at, max_score, reschedule_note, rescheduled_by)
         VALUES ($1::uuid, $2::uuid, 'SCHEDULED', $3, $4, $5, $6::uuid)`,
        quizId, staffId, availableAt, await this.totalPoints(quizId), noteVal, byUserId,
      );
    }

    const when = availableAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
    await this.notifyStaff(staffId, {
      title: 'Quiz rescheduled',
      body: `"${quiz.title}" ab ${when} ko khulegi.${noteVal ? ` Trainer: ${noteVal}` : ''}`,
      template: 'QUIZ_RESCHEDULED',
      payload: { quizId, availableAt: availableAt.toISOString() },
    });
    this.logger.log(`[QUIZ] Rescheduled quiz ${quizId} for staff ${staffId} at ${availableAt.toISOString()}`);

    const [row] = (await this.staffQuizzes(staffId, { quizId }));
    return row;
  }

  // ── Staff (mobile) ──────────────────────────────────────────────────────

  /** The staff app's training home: batches with schedule, material and quizzes, plus video-cert progress. */
  async getMyTraining(staffId: string) {
    const [staff] = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, full_name, staff_code, series, pipeline_stage FROM staff_applicants WHERE id = $1::uuid`, staffId,
    );
    if (!staff) throw new NotFoundException('Staff applicant not found');
    const batches = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT tb.id, tb.batch_code, tb.series, tb.trainer_name, tb.classroom, tb.status,
              to_char(tb.start_date, 'YYYY-MM-DD') AS start_date,
              to_char(tb.end_date, 'YYYY-MM-DD') AS end_date,
              to_char(tb.quiz_date, 'YYYY-MM-DD') AS quiz_date,
              be.created_at AS enrolled_at
       FROM batch_enrollments be JOIN training_batches tb ON tb.id = be.batch_id
       WHERE be.staff_id = $1::uuid
       ORDER BY tb.start_date DESC`,
      staffId,
    );
    const quizzes = await this.staffQuizzes(staffId);

    const seriesShort = mapSeriesToShort(staff.series);
    const [video] = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(DISTINCT prompt_key)::int AS approved FROM video_certifications
       WHERE staff_id = $1::uuid AND review_status = 'APPROVED'`,
      staffId,
    );

    return {
      staff: {
        id: staff.id, fullName: staff.full_name, staffCode: staff.staff_code,
        series: seriesShort, pipelineStage: staff.pipeline_stage,
      },
      videoCert: { approved: video?.approved ?? 0, required: REQUIRED_VIDEO_PROMPTS[seriesShort] ?? 0 },
      batches: await Promise.all(batches.map(async (b) => ({
        id: b.id,
        batchCode: b.batch_code,
        series: b.series,
        trainerName: b.trainer_name,
        classroom: b.classroom,
        status: b.status,
        startDate: b.start_date,
        endDate: b.end_date,
        quizDate: b.quiz_date,
        enrolledAt: b.enrolled_at,
        materials: (await this.materials.list(b.id)).map((m) => ({
          id: m.id, type: m.type, title: m.title, body: m.body, sizeBytes: m.sizeBytes, viewUrl: m.viewUrl, createdAt: m.createdAt,
        })),
        quizzes: quizzes.filter((q) => q.batchId === b.id),
      }))),
    };
  }

  /** Every quiz in the staff member's batches, with its derived state — see StaffQuizState. */
  async staffQuizzes(staffId: string, filter: { quizId?: string } = {}) {
    const params: any[] = [staffId];
    let extra = '';
    if (filter.quizId) { params.push(filter.quizId); extra = `AND q.id = $2::uuid`; }
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT q.id, q.batch_id, q.title, q.pass_marks, tb.batch_code,
              to_char(tb.quiz_date, 'YYYY-MM-DD') AS quiz_date,
              (tb.quiz_date IS NOT NULL AND tb.quiz_date > (now() AT TIME ZONE 'Asia/Kolkata')::date) AS before_quiz_date,
              (SELECT COUNT(*)::int FROM quiz_questions WHERE quiz_id = q.id) AS question_count,
              (SELECT COALESCE(SUM(points), 0)::int FROM quiz_questions WHERE quiz_id = q.id) AS total_points
       FROM training_quizzes q
       JOIN training_batches tb ON tb.id = q.batch_id
       JOIN batch_enrollments be ON be.batch_id = q.batch_id
       WHERE be.staff_id = $1::uuid ${extra}
       ORDER BY q.created_at ASC`,
      ...params,
    );
    if (!rows.length) return [];
    const history = await this.attemptHistory(rows.map((r) => r.id), staffId);

    return rows.map((r) => {
      const attempts = history.get(`${r.id}:${staffId}`) ?? [];
      const latest = attempts[attempts.length - 1];
      const { state, opensAt } = this.staffState(latest, r.before_quiz_date, r.quiz_date);
      const lastGraded = [...attempts].reverse().find((a) => a.status === 'GRADED');
      return {
        id: r.id,
        batchId: r.batch_id,
        batchCode: r.batch_code,
        title: r.title,
        questionCount: r.question_count,
        totalPoints: r.total_points,
        passMarks: this.effectivePassMarks(r.pass_marks, r.total_points),
        quizDate: r.quiz_date,
        state,
        opensAt,
        attemptId: latest && latest.status !== 'SCHEDULED' ? latest.id : null,
        rescheduleNote: state === 'SCHEDULED' || state === 'AVAILABLE' ? latest?.reschedule_note ?? null : null,
        lastResult: lastGraded
          ? { attemptId: lastGraded.id, score: lastGraded.auto_score, maxScore: lastGraded.max_score, passed: lastGraded.passed, gradedAt: lastGraded.graded_at }
          : null,
        attempts: attempts.filter((a) => a.status !== 'SCHEDULED').map((a, i) => this.mapHistoryEntry(a, i)),
      };
    });
  }

  /** Starts (or resumes) the attempt currently open to this staff member; returns it with its questions. */
  async startAttempt(quizId: string, staffId: string) {
    await this.assertEnrolled(quizId, staffId);
    const [q] = await this.staffQuizzes(staffId, { quizId });
    const history = (await this.attemptHistory([quizId], staffId)).get(`${quizId}:${staffId}`) ?? [];
    const latest = history[history.length - 1];

    switch (q.state) {
      case 'LOCKED': throw new ConflictException(`Quiz opens on ${q.opensAt}`);
      case 'SCHEDULED': throw new ConflictException(`Quiz opens at ${new Date(q.opensAt!).toISOString()}`);
      case 'UNDER_REVIEW': throw new ConflictException('Waiting on the trainer to check your last attempt');
      case 'PASSED': throw new ConflictException('This quiz has already been passed');
      case 'FAILED': throw new ConflictException('Your trainer will reschedule this quiz');
    }

    let attemptId: string;
    if (q.state === 'IN_PROGRESS') {
      attemptId = latest.id;
    } else if (latest?.status === 'SCHEDULED') {
      await this.prisma.$executeRawUnsafe(
        `UPDATE quiz_attempts SET status = 'IN_PROGRESS', started_at = now(), max_score = $1 WHERE id = $2::uuid`,
        q.totalPoints, latest.id,
      );
      attemptId = latest.id;
    } else {
      const [created] = await this.prisma.$queryRawUnsafe<any[]>(
        `INSERT INTO quiz_attempts (quiz_id, staff_id, status, started_at, max_score)
         VALUES ($1::uuid, $2::uuid, 'IN_PROGRESS', now(), $3) RETURNING id`,
        quizId, staffId, q.totalPoints,
      );
      attemptId = created.id;
    }
    return {
      ...this.mapAttempt(await this.findAttempt(attemptId)),
      title: q.title,
      totalPoints: q.totalPoints,
      passMarks: q.passMarks,
      questions: await this.getQuestionsForAttempt(attemptId, staffId),
    };
  }

  /** Questions WITHOUT the answer key — what a client taking the quiz gets. */
  async getQuestionsForAttempt(attemptId: string, staffId: string) {
    const attempt = await this.assertOwnsAttempt(attemptId, staffId);
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, question_text, type, options, order_index, points
       FROM quiz_questions WHERE quiz_id = $1::uuid ORDER BY order_index ASC`,
      attempt.quiz_id,
    );
    return rows.map((q) => this.mapQuestion(q, false));
  }

  /**
   * MCQ is marked now; an unanswered question is marked ✘ now. Answered TEXT
   * waits for the trainer (UNDER_REVIEW). With nothing to review, the attempt
   * is graded straight away.
   */
  async submitAttempt(
    attemptId: string,
    staffId: string,
    answers: { question_id: string; selected_option?: number | null; answer_text?: string | null }[],
  ) {
    const attempt = await this.assertOwnsAttempt(attemptId, staffId);
    if (attempt.status !== 'IN_PROGRESS') {
      throw new BadRequestException(`Attempt is ${attempt.status}, not IN_PROGRESS`);
    }
    const questions = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, type, options, correct_option, points FROM quiz_questions WHERE quiz_id = $1::uuid`, attempt.quiz_id,
    );
    const given = new Map((answers ?? []).map((a) => [a.question_id, a]));
    for (const id of given.keys()) {
      if (!questions.some((q) => q.id === id)) throw new BadRequestException(`Question ${id} is not part of this quiz`);
    }

    let pending = 0;
    for (const q of questions) {
      const a = given.get(q.id);
      const selected = a?.selected_option ?? null;
      const text = a?.answer_text?.trim() || null;
      let isCorrect: boolean | null;
      if (q.type === 'MCQ') {
        const optionCount = Array.isArray(q.options) ? q.options.length : 0;
        if (selected != null && (!Number.isInteger(selected) || selected < 0 || selected >= optionCount)) {
          throw new BadRequestException(`selected_option out of range for question ${q.id}`);
        }
        isCorrect = selected != null && selected === q.correct_option;
      } else if (text) {
        isCorrect = null;
        pending++;
      } else {
        isCorrect = false;
      }
      const pointsAwarded = isCorrect == null ? null : isCorrect ? q.points : 0;
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO quiz_answers (attempt_id, question_id, selected_option, answer_text, is_correct, points_awarded)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
         ON CONFLICT (attempt_id, question_id) DO UPDATE
           SET selected_option = $3, answer_text = $4, is_correct = $5, points_awarded = $6`,
        attemptId, q.id, q.type === 'MCQ' ? selected : null, q.type === 'TEXT' ? text : null, isCorrect, pointsAwarded,
      );
    }

    const totalPoints = questions.reduce((s, q) => s + q.points, 0);
    const [quiz] = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT title, pass_marks FROM training_quizzes WHERE id = $1::uuid`, attempt.quiz_id,
    );
    const passMarks = this.effectivePassMarks(quiz.pass_marks, totalPoints);

    if (pending > 0) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE quiz_attempts SET status = 'SUBMITTED', submitted_at = now(), max_score = $1 WHERE id = $2::uuid`,
        totalPoints, attemptId,
      );
      return { attemptId, state: 'UNDER_REVIEW' as StaffQuizState, pendingReview: true, score: null, maxScore: totalPoints, passMarks, passed: null };
    }

    const [{ score }] = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT COALESCE(SUM(points_awarded), 0)::int AS score FROM quiz_answers WHERE attempt_id = $1::uuid`, attemptId,
    );
    const passed = score >= passMarks;
    await this.prisma.$executeRawUnsafe(
      `UPDATE quiz_attempts SET status = 'GRADED', submitted_at = now(), graded_at = now(),
              auto_score = $1, max_score = $2, passed = $3
       WHERE id = $4::uuid`,
      score, totalPoints, passed, attemptId,
    );
    await this.notifyResult(staffId, { quizId: attempt.quiz_id, attemptId }, quiz.title, score, totalPoints, passed);
    return {
      attemptId, state: (passed ? 'PASSED' : 'FAILED') as StaffQuizState, pendingReview: false,
      score, maxScore: totalPoints, passMarks, passed,
    };
  }

  /** The staff member's own result: marks and ✔/✘ per question — never the correct answer. */
  async getResultForStaff(attemptId: string, staffId: string) {
    const attempt = await this.assertOwnsAttempt(attemptId, staffId);
    if (attempt.status === 'SUBMITTED') {
      return { attemptId, state: 'UNDER_REVIEW' as StaffQuizState, score: null, maxScore: attempt.max_score, passMarks: null, passed: null, questions: [] };
    }
    if (attempt.status !== 'GRADED') throw new BadRequestException(`Attempt is ${attempt.status} — no result yet`);

    const [quiz] = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT title, pass_marks FROM training_quizzes WHERE id = $1::uuid`, attempt.quiz_id,
    );
    const questions = await this.questionsWithAnswers(attemptId, attempt.quiz_id);
    const totalPoints = questions.reduce((s, q) => s + q.points, 0);
    return {
      attemptId,
      title: quiz.title,
      state: (attempt.passed ? 'PASSED' : 'FAILED') as StaffQuizState,
      score: attempt.auto_score,
      maxScore: totalPoints,
      passMarks: this.effectivePassMarks(quiz.pass_marks, totalPoints),
      passed: attempt.passed,
      gradedAt: attempt.graded_at,
      questions: questions.map((q) => ({
        questionId: q.id,
        questionText: q.question_text,
        type: q.type,
        options: q.options,
        points: q.points,
        yourSelectedOption: q.selected_option,
        yourAnswerText: q.answer_text,
        correct: q.is_correct === true,
        pointsAwarded: q.points_awarded ?? 0,
      })),
    };
  }

  // ── Shared internals ─────────────────────────────────────────────────────

  private validateQuiz(input: QuizInput) {
    if (!input.title?.trim()) throw new BadRequestException('title is required');
    if (!input.questions?.length) throw new BadRequestException('At least one question is required');
    let total = 0;
    for (const [i, q] of input.questions.entries()) {
      if (!q.question_text?.trim()) throw new BadRequestException(`Question ${i + 1}: question_text is required`);
      const type = q.type ?? 'MCQ';
      if (type !== 'MCQ' && type !== 'TEXT') throw new BadRequestException(`Question ${i + 1}: type must be MCQ or TEXT`);
      const points = q.points ?? 1;
      if (!Number.isInteger(points) || points < 1) throw new BadRequestException(`Question ${i + 1}: points must be a whole number ≥ 1`);
      total += points;
      if (type === 'MCQ') {
        const opts = (q.options ?? []).map((o) => String(o ?? '').trim());
        if (opts.length < 2 || opts.some((o) => !o)) throw new BadRequestException(`Question ${i + 1}: MCQ needs at least 2 non-empty options`);
        if (q.correct_option == null || q.correct_option < 0 || q.correct_option >= opts.length) {
          throw new BadRequestException(`Question ${i + 1}: correct_option must index into options`);
        }
      }
    }
    if (input.pass_marks != null) {
      if (!Number.isInteger(input.pass_marks) || input.pass_marks < 1 || input.pass_marks > total) {
        throw new BadRequestException(`pass_marks must be between 1 and the quiz total (${total})`);
      }
    }
  }

  private async insertQuestions(db: PrismaService, quizId: string, questions: QuizQuestionInput[]) {
    for (const [i, q] of questions.entries()) {
      const type = q.type ?? 'MCQ';
      await db.$executeRawUnsafe(
        `INSERT INTO quiz_questions (quiz_id, question_text, type, options, correct_option, order_index, points)
         VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6, $7)`,
        quizId, q.question_text.trim(), type,
        type === 'MCQ' ? JSON.stringify(q.options!.map((o) => String(o).trim())) : null,
        type === 'MCQ' ? q.correct_option : null,
        i, q.points ?? 1,
      );
    }
  }

  private effectivePassMarks(passMarks: number | null | undefined, totalPoints: number): number {
    if (passMarks != null) return passMarks;
    return Math.ceil(totalPoints * DEFAULT_PASS_RATIO);
  }

  private async totalPoints(quizId: string): Promise<number> {
    const [r] = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT COALESCE(SUM(points), 0)::int AS total FROM quiz_questions WHERE quiz_id = $1::uuid`, quizId,
    );
    return r.total;
  }

  /** Attempts grouped by "quizId:staffId", oldest first. */
  private async attemptHistory(quizIds: string[], staffId?: string): Promise<Map<string, any[]>> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM quiz_attempts WHERE quiz_id = ANY($1::uuid[]) ${staffId ? 'AND staff_id = $2::uuid' : ''}
       ORDER BY created_at ASC`,
      ...(staffId ? [quizIds, staffId] : [quizIds]),
    );
    const map = new Map<string, any[]>();
    for (const r of rows) {
      const key = `${r.quiz_id}:${r.staff_id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return map;
  }

  private questionsWithAnswers(attemptId: string, quizId: string) {
    return this.prisma.$queryRawUnsafe<any[]>(
      `SELECT qq.id, qq.question_text, qq.type, qq.options, qq.correct_option, qq.points, qq.order_index,
              qa.id AS answer_id, qa.selected_option, qa.answer_text, qa.is_correct, qa.points_awarded
       FROM quiz_questions qq
       LEFT JOIN quiz_answers qa ON qa.question_id = qq.id AND qa.attempt_id = $1::uuid
       WHERE qq.quiz_id = $2::uuid ORDER BY qq.order_index ASC`,
      attemptId, quizId,
    );
  }

  private staffState(latest: any, beforeQuizDate: boolean, quizDate: string | null): { state: StaffQuizState; opensAt: string | null } {
    if (!latest) return beforeQuizDate ? { state: 'LOCKED', opensAt: quizDate } : { state: 'AVAILABLE', opensAt: null };
    switch (latest.status) {
      case 'SCHEDULED':
        return new Date(latest.available_at) > new Date()
          ? { state: 'SCHEDULED', opensAt: new Date(latest.available_at).toISOString() }
          : { state: 'AVAILABLE', opensAt: null };
      case 'IN_PROGRESS':
      case 'AVAILABLE':
        return { state: 'IN_PROGRESS', opensAt: null };
      case 'SUBMITTED':
        return { state: 'UNDER_REVIEW', opensAt: null };
      default:
        return { state: latest.passed ? 'PASSED' : 'FAILED', opensAt: null };
    }
  }

  private submissionState(latest: any): SubmissionState {
    if (!latest) return 'NOT_ATTEMPTED';
    switch (latest.status) {
      case 'SCHEDULED': return 'SCHEDULED';
      case 'IN_PROGRESS':
      case 'AVAILABLE': return 'IN_PROGRESS';
      case 'SUBMITTED': return 'PENDING_REVIEW';
      default: return latest.passed ? 'PASSED' : 'FAILED';
    }
  }

  private emptyCounts(): Record<SubmissionState, number> {
    return { NOT_ATTEMPTED: 0, SCHEDULED: 0, IN_PROGRESS: 0, PENDING_REVIEW: 0, PASSED: 0, FAILED: 0 };
  }

  /**
   * Which batches a user may see. TRAINER: batches they created (rm_id) or are
   * the trainer of — trainer_id holds either their users.id or their HR
   * employees.id, depending on how the batch was made. Branch-scoped roles
   * stay in their branch. `b` must alias training_batches.
   */
  private scopeClauses(user: ScopeUser): string[] {
    const out: string[] = [];
    if (user.branchId && UUID_RE.test(user.branchId)) out.push(`b.branch_id = '${user.branchId}'::uuid`);
    if (user.role === 'TRAINER' && UUID_RE.test(user.id)) {
      out.push(`(b.rm_id = '${user.id}'::uuid OR b.trainer_id = '${user.id}'::uuid OR b.trainer_id IN (
        SELECT e.id FROM employees e JOIN users u ON u.phone = e.mobile
        WHERE u.id = '${user.id}'::uuid AND e.deleted_at IS NULL))`);
    }
    return out;
  }

  private async notifyResult(staffId: string, ids: { quizId: string; attemptId: string }, quizTitle: string, score: number, max: number, passed: boolean) {
    await this.notifyStaff(staffId, {
      title: passed ? 'Quiz passed' : 'Quiz result',
      body: passed
        ? `"${quizTitle}" me aapke ${score}/${max} marks aaye — Pass!`
        : `"${quizTitle}" me aapke ${score}/${max} marks aaye. Trainer aapki quiz dobara schedule karenge.`,
      template: passed ? 'QUIZ_PASSED' : 'QUIZ_FAILED',
      payload: { ...ids, score: String(score), max: String(max) },
    });
  }

  /** In-app notification to the staff member's login account; never fails the calling action. */
  private async notifyStaff(staffId: string, n: { title: string; body: string; template: string; payload: Record<string, string> }) {
    try {
      const users = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT u.id FROM users u JOIN staff_applicants sa ON sa.mobile = u.phone
         WHERE sa.id = $1::uuid AND u.role = 'STAFF' LIMIT 1`,
        staffId,
      );
      if (!users.length) return;
      await this.prisma.notification.create({
        data: {
          userId: users[0].id,
          channel: NotificationChannel.IN_APP,
          title: n.title,
          body: n.body,
          template: n.template,
          payload: n.payload,
          status: 'SENT',
          sentAt: new Date(),
        },
      });
    } catch (e: any) {
      this.logger.warn(`[QUIZ] Could not notify staff ${staffId}: ${e?.message}`);
    }
  }

  private async assertBatchExists(batchId: string): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM training_batches WHERE id = $1::uuid`, batchId,
    ).catch(() => []);
    if (!rows.length) throw new NotFoundException(`Batch ${batchId} not found`);
  }

  private async findQuiz(quizId: string): Promise<any> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, batch_id, title, pass_marks, created_by, created_at, updated_at FROM training_quizzes WHERE id = $1::uuid`, quizId,
    );
    if (!rows.length) throw new NotFoundException(`Quiz ${quizId} not found`);
    return rows[0];
  }

  private async findAttempt(attemptId: string): Promise<any> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(`SELECT * FROM quiz_attempts WHERE id = $1::uuid`, attemptId);
    if (!rows.length) throw new NotFoundException(`Attempt ${attemptId} not found`);
    return rows[0];
  }

  private async assertEnrolled(quizId: string, staffId: string): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT 1 FROM training_quizzes q
       JOIN batch_enrollments be ON be.batch_id = q.batch_id
       WHERE q.id = $1::uuid AND be.staff_id = $2::uuid`,
      quizId, staffId,
    );
    if (!rows.length) throw new ForbiddenException('Not enrolled in the batch this quiz belongs to');
  }

  private async assertOwnsAttempt(attemptId: string, staffId: string): Promise<any> {
    const attempt = await this.findAttempt(attemptId);
    if (attempt.staff_id !== staffId) throw new ForbiddenException('Not your attempt');
    return attempt;
  }

  private mapQuiz(r: any) {
    return { id: r.id, batchId: r.batch_id, title: r.title, createdBy: r.created_by, createdAt: r.created_at };
  }

  private mapQuestion(r: any, includeAnswerKey: boolean) {
    const base = {
      id: r.id,
      questionText: r.question_text,
      type: r.type,
      options: r.options,
      orderIndex: r.order_index,
      points: r.points,
    };
    return includeAnswerKey ? { ...base, correctOption: r.correct_option } : base;
  }

  private mapHistoryEntry(a: any, i: number) {
    return {
      attemptId: a.id,
      attemptNumber: i + 1,
      status: a.status,
      score: a.status === 'GRADED' ? a.auto_score : null,
      maxScore: a.max_score,
      passed: a.status === 'GRADED' ? a.passed : null,
      availableAt: a.available_at,
      submittedAt: a.submitted_at,
      gradedAt: a.graded_at,
      rescheduleNote: a.reschedule_note ?? null,
    };
  }

  private mapAttempt(r: any) {
    return {
      id: r.id, quizId: r.quiz_id, staffId: r.staff_id, status: r.status,
      availableAt: r.available_at, startedAt: r.started_at, submittedAt: r.submitted_at,
      autoScore: r.auto_score, maxScore: r.max_score, passed: r.passed,
      gradedAt: r.graded_at, gradedBy: r.graded_by, createdAt: r.created_at,
    };
  }
}
