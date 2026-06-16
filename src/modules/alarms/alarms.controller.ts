import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { AlarmsService } from './alarms.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CreateAlarmDto } from './dto/create-alarm.dto';
import { AlarmActionDto } from './dto/alarm-action.dto';

@ApiTags('Alarms & Issues')
@ApiBearerAuth()
@Controller({ path: 'alarms', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class AlarmsController {
  constructor(private readonly alarmsService: AlarmsService) {}

  @Post()
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  @ApiOperation({ summary: 'Create a new alarm/issue' })
  async create(@Body() createAlarmDto: CreateAlarmDto) {
    return this.alarmsService.createAlarm(createAlarmDto);
  }

  @Post('mark-all-read')
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  @ApiOperation({ summary: 'Mark all alarms as read' })
  async markAllRead() {
    return this.alarmsService.markAllRead();
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  @ApiOperation({ summary: 'List alarms (optional filters: severity, category, status)' })
  async findAll(@Query('severity') severity?: string, @Query('category') category?: string, @Query('status') status?: string) {
    return this.alarmsService.findAll({ severity, category, status });
  }

  @Get('stats')
  @Roles(UserRole.ADMIN, UserRole.BM)
  @ApiOperation({ summary: 'Get alarm statistics' })
  async getStats() {
    return this.alarmsService.getStats();
  }

  @Patch(':id/read')
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  @ApiOperation({ summary: 'Mark one alarm as read' })
  async markRead(@Param('id') id: string) {
    return this.alarmsService.markRead(id);
  }

  @Patch(':id/action')
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  @ApiOperation({ summary: 'Save BM note and/or action status' })
  async saveAction(@Param('id') id: string, @Body() dto: AlarmActionDto, @Req() req: any) {
    return this.alarmsService.saveBmAction(id, dto, req.user.id);
  }

  @Patch(':id/resolve')
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  @ApiOperation({ summary: 'Mark an alarm as resolved' })
  async resolve(@Param('id') id: string, @Req() req: any) {
    return this.alarmsService.resolveAlarm(id, req.user.id);
  }
}
