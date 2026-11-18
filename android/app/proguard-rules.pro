# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class com.e404.homehub.** { *** Companion; }
-keepclasseswithmembers class com.e404.homehub.** { kotlinx.serialization.KSerializer serializer(...); }
# Firestore model mapping uses reflection on data classes
-keepclassmembers class com.e404.homehub.data.model.** { *; }

# PDFBox (statement import): loads security handlers and filters reflectively; optional image codecs aren't shipped.
-keep class com.tom_roush.pdfbox.** { *; }
-dontwarn com.tom_roush.pdfbox.**
-dontwarn com.gemalto.jp2.**
