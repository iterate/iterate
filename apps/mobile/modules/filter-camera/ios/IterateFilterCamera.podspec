Pod::Spec.new do |s|
  s.name = 'IterateFilterCamera'
  s.version = '1.0.0'
  s.summary = 'Native camera rendering and incremental recording for Iterate filters'
  s.description = s.summary
  s.license = { :type => 'AGPL-3.0-only' }
  s.author = 'Iterate'
  s.homepage = 'https://github.com/iterate/iterate'
  s.source = { :git => 'https://github.com/iterate/iterate.git' }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'CoreGraphics', 'CoreImage', 'CoreText', 'ImageIO', 'JavaScriptCore', 'Vision'
  s.source_files = '**/*.swift'
end
