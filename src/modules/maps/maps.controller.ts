import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Geolocation Services')
@Controller({ path: 'maps', version: '1' })
export class MapsController {
  @Public()
  @Get('geocode')
  @ApiOperation({ summary: 'Geocode address string to latitude/longitude' })
  geocode(@Query('address') address: string) {
    return {
      status: 'OK',
      formattedAddress: address || 'Sector 62, Noida, Uttar Pradesh, India',
      location: {
        lat: 28.5355,
        lng: 77.3910,
      },
    };
  }

  @Public()
  @Get('reverse-geocode')
  @ApiOperation({ summary: 'Reverse geocode latitude/longitude to address' })
  reverseGeocode(@Query('lat') lat: string, @Query('lng') lng: string) {
    return {
      status: 'OK',
      formattedAddress: 'Sector 62, Noida, Uttar Pradesh, India',
      placeId: 'ChIJ5b8w...',
      components: {
        city: 'Noida',
        state: 'Uttar Pradesh',
        country: 'India',
        pincode: '201309',
      },
    };
  }
}
