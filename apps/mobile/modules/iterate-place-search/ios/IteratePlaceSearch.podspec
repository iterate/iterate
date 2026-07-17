Pod::Spec.new do |s|
  s.name = 'IteratePlaceSearch'
  s.version = '0.1.0'
  s.summary = 'Nearby semantic place search for Iterate location reminders'
  s.description = 'An iOS-only Expo module backed by MKLocalSearch.'
  s.author = 'Iterate'
  s.homepage = 'https://github.com/iterate/iterate'
  s.platforms = { :ios => '15.1' }
  s.source = { git: 'https://github.com/iterate/iterate.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
